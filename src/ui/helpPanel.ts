/**
 * Lighting help panel (T070): a small "?" ink button shown during calibration
 * only. Opens a parchment panel with webcam tracking tips, closed by its own
 * button or by pressing the "?" again. No em dashes, warm palette, no
 * gameplay coupling: mount and dispose, nothing else.
 */

/** The tips, exported so tests can assert the copy without a DOM. */
export const HELP_TIPS: readonly string[] = [
  'Face a window or a lamp so the light lands on you.',
  'Avoid a strong light behind you. Backlight hides your hands.',
  'Keep both hands inside the camera frame.',
  'Roll your sleeves up past the wrist.',
];

export const HELP_TITLE = 'Help the camera see you.';

export class HelpPanel {
  private readonly button: HTMLButtonElement;
  private readonly panel: HTMLDivElement;
  private open = false;

  constructor(root: HTMLElement) {
    this.button = document.createElement('button');
    this.button.type = 'button';
    this.button.className = 'fb-help-btn';
    this.button.textContent = '?';
    this.button.setAttribute('aria-label', 'Lighting and tracking help');
    this.button.addEventListener('click', () => this.toggle());

    this.panel = document.createElement('div');
    this.panel.className = 'fb-panel fb-help-panel';
    const heading = document.createElement('h3');
    heading.className = 'fb-help-heading';
    heading.textContent = HELP_TITLE;
    const list = document.createElement('ul');
    list.className = 'fb-help-list';
    for (const tip of HELP_TIPS) {
      const item = document.createElement('li');
      item.textContent = tip;
      list.appendChild(item);
    }
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'fb-help-close';
    close.textContent = 'Close';
    close.addEventListener('click', () => this.setOpen(false));
    this.panel.append(heading, list, close);

    root.append(this.button, this.panel);
  }

  get isOpen(): boolean {
    return this.open;
  }

  private toggle(): void {
    this.setOpen(!this.open);
  }

  private setOpen(open: boolean): void {
    this.open = open;
    this.panel.classList.toggle('is-open', open);
  }

  dispose(): void {
    this.button.remove();
    this.panel.remove();
  }
}
