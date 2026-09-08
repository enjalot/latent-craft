/** One reversible visibility switch. Hidden panels retain their state, not focus. */
export class UiVisibility {
  readonly button = document.createElement("button");
  private hidden = false;
  constructor(private readonly container: HTMLElement, private readonly canvas: HTMLElement, private readonly onHide: () => void) {
    this.button.type = "button";
    this.button.className = "hud-button lc-ui-toggle";
    this.button.textContent = "Hide UI";
    this.button.setAttribute("aria-pressed", "false");
    this.button.addEventListener("click", this.toggle);
    container.append(this.button);
  }
  private toggle = () => {
    this.hidden = !this.hidden;
    if (this.hidden) this.onHide();
    this.container.classList.toggle("lc-ui-hidden", this.hidden);
    this.button.textContent = this.hidden ? "Show UI" : "Hide UI";
    this.button.setAttribute("aria-pressed", String(this.hidden));
    // Returning keyboard focus to the map must not leave a hidden input active.
    this.canvas.focus({ preventScroll: true });
  };
  dispose(): void { this.container.classList.remove("lc-ui-hidden"); this.button.remove(); }
}
