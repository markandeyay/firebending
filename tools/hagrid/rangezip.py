"""Read individual members of a remote zip over HTTP range requests.

The HaGRID 500k sample on HuggingFace is a single 13.4 GB zip; we only need
the annotation JSONs inside it (a few MB). A zip's central directory lives at
the end of the file, so we fetch the tail, parse the member listing with
zipfile, then range-request and inflate just the members we want.
"""

from __future__ import annotations

import io
import struct
import zipfile
import zlib

import requests


class RemoteZip:
    def __init__(self, url: str, session: requests.Session | None = None):
        self.url = url
        self.session = session or requests.Session()
        self.bytes_downloaded = 0
        head = self.session.head(url, allow_redirects=True)
        head.raise_for_status()
        self.size = int(head.headers["Content-Length"])
        self.url = head.url  # follow redirects once (e.g. HF -> CDN)
        self._load_central_directory()

    def _fetch(self, start: int, end_exclusive: int) -> bytes:
        r = self.session.get(
            self.url,
            headers={"Range": f"bytes={start}-{end_exclusive - 1}"},
        )
        r.raise_for_status()
        data = r.content
        self.bytes_downloaded += len(data)
        return data

    def _load_central_directory(self) -> None:
        # EOCD is within the last 64 KiB unless the archive comment is huge.
        tail_len = min(self.size, 65 * 1024)
        tail = self._fetch(self.size - tail_len, self.size)
        eocd_off = tail.rfind(b"PK\x05\x06")
        if eocd_off < 0:
            raise RuntimeError("EOCD not found in zip tail")
        eocd = tail[eocd_off : eocd_off + 22]
        cd_size, cd_offset = struct.unpack("<II", eocd[12:20])
        if cd_offset == 0xFFFFFFFF or cd_size == 0xFFFFFFFF:
            # Zip64: locate the zip64 EOCD record.
            loc_off = tail.rfind(b"PK\x06\x07", 0, eocd_off)
            if loc_off < 0:
                raise RuntimeError("zip64 EOCD locator not found")
            z64_eocd_pos = struct.unpack("<Q", tail[loc_off + 8 : loc_off + 16])[0]
            z64_local = z64_eocd_pos - (self.size - tail_len)
            if z64_local >= 0:
                rec = tail[z64_local : z64_local + 56]
            else:
                rec = self._fetch(z64_eocd_pos, z64_eocd_pos + 56)
            cd_size = struct.unpack("<Q", rec[40:48])[0]
            cd_offset = struct.unpack("<Q", rec[48:56])[0]
        cd = self._fetch(cd_offset, cd_offset + cd_size)
        # Feed zipfile a synthetic archive: central directory + EOCD with
        # offsets rebased to 0.
        eocd_full = bytearray(tail[eocd_off : eocd_off + 22])
        struct.pack_into("<II", eocd_full, 12, cd_size, 0)
        synthetic = cd + bytes(eocd_full)
        zf = zipfile.ZipFile(io.BytesIO(synthetic))
        self.infos = {i.filename: i for i in zf.infolist()}

    def namelist(self) -> list[str]:
        return list(self.infos)

    def read(self, name: str) -> bytes:
        info = self.infos[name]
        # header_offset is relative to archive start; read the local header
        # to find the actual data start (its extra field can differ in size).
        lh = self._fetch(info.header_offset, info.header_offset + 30)
        if lh[:4] != b"PK\x03\x04":
            raise RuntimeError(f"bad local header for {name}")
        name_len, extra_len = struct.unpack("<HH", lh[26:30])
        data_start = info.header_offset + 30 + name_len + extra_len
        raw = self._fetch(data_start, data_start + info.compress_size)
        if info.compress_type == zipfile.ZIP_STORED:
            return raw
        if info.compress_type == zipfile.ZIP_DEFLATED:
            return zlib.decompress(raw, -15)
        raise RuntimeError(f"unsupported compression {info.compress_type}")
