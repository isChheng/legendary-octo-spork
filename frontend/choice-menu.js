export function enhanceSelect(select, { fixedCaption = false, alignEnd = false, searchLabel } = {}) {
  if (typeof HTMLElement.prototype.showPopover !== "function") return;
  const label = select.labels[0];
  const caption = label.textContent;
  const trigger = document.createElement("button");
  const value = document.createElement("span");
  const chevron = document.createElement("span");
  const menu = document.createElement("div");
  const title = document.createElement("p");
  const options = document.createElement("div");

  trigger.type = "button";
  trigger.id = `${select.id}-trigger`;
  trigger.className = "choice-trigger";
  trigger.setAttribute("aria-haspopup", "menu");
  trigger.setAttribute("aria-expanded", "false");
  value.id = `${select.id}-value`;
  label.id = `${select.id}-label`;
  label.htmlFor = trigger.id;
  trigger.setAttribute("aria-labelledby", fixedCaption ? value.id : `${label.id} ${value.id}`);
  chevron.className = "chevron";
  chevron.setAttribute("aria-hidden", "true");
  trigger.append(value, chevron);

  menu.id = `${select.id}-menu`;
  menu.className = "choice-menu";
  menu.popover = "auto";
  title.className = "choice-title";
  title.textContent = caption;
  title.id = `${menu.id}-title`;
  options.setAttribute("role", "menu");
  options.setAttribute("aria-labelledby", title.id);
  menu.append(title, options);
  let search;
  if (searchLabel) {
    menu.classList.add("choice-menu-searchable");
    options.classList.add("choice-scroll-list");
    search = document.createElement("input");
    search.type = "search";
    search.inputMode = "numeric";
    search.className = "choice-search";
    search.placeholder = searchLabel;
    search.setAttribute("aria-label", searchLabel);
    menu.insertBefore(search, options);
  }
  trigger.setAttribute("aria-controls", menu.id);
  trigger.popoverTargetElement = menu;
  select.after(trigger, menu);
  select.hidden = true;

  const isOpen = () => menu.matches(":popover-open");
  const items = () => Array.from(options.querySelectorAll("button:not(:disabled):not([hidden])"));

  function filterOptions() {
    const query = search.value.trim();
    for (const item of options.children) item.hidden = !item.textContent.includes(query);
    options.scrollTop = 0;
    position();
  }
  search?.addEventListener("input", filterOptions);

  function position() {
    const anchor = trigger.getBoundingClientRect();
    if (!anchor.width || anchor.bottom < 0 || anchor.top > window.innerHeight) {
      menu.hidePopover();
      return;
    }
    const inset = 12;
    const gap = 8;
    const below = window.innerHeight - anchor.bottom - gap - inset;
    const above = anchor.top - gap - inset;
    const naturalHeight = menu.scrollHeight + menu.offsetHeight - menu.clientHeight;
    const opensUp = naturalHeight > below && above > below;
    menu.style.setProperty("--choice-offset", opensUp ? "5px" : "-5px");
    menu.style.maxHeight = `${Math.max(0, opensUp ? above : below)}px`;
    const left = alignEnd ? anchor.right - menu.offsetWidth : anchor.left;
    menu.style.left = `${Math.max(inset, Math.min(left, document.documentElement.clientWidth - menu.offsetWidth - inset))}px`;
    menu.style.top = `${opensUp ? anchor.top - gap - menu.offsetHeight : anchor.bottom + gap}px`;
  }

  function render() {
    trigger.disabled = select.disabled;
    value.textContent = fixedCaption ? caption : select.selectedOptions[0]?.textContent ?? caption;
    options.replaceChildren(...Array.from(select.options, (option) => {
      const item = document.createElement("button");
      const check = document.createElement("span");
      item.type = "button";
      item.role = "menuitemradio";
      item.tabIndex = -1;
      item.disabled = option.disabled;
      item.setAttribute("aria-checked", String(option.selected));
      check.className = "choice-check";
      check.setAttribute("aria-hidden", "true");
      item.append(check, option.textContent);
      item.addEventListener("click", () => {
        menu.hidePopover();
        trigger.focus();
        if (select.value === option.value) return;
        select.value = option.value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
      return item;
    }));
  }

  menu.addEventListener("beforetoggle", (event) => {
    const opening = event.newState === "open";
    trigger.setAttribute("aria-expanded", String(opening));
    if (!opening) {
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position);
    }
  });
  menu.addEventListener("toggle", () => {
    if (!isOpen()) return;
    position();
    if (!isOpen()) return;
    const selected = options.querySelector('[aria-checked="true"]:not(:disabled)') ?? items()[0];
    if (search) search.focus({ preventScroll: true });
    else {
      selected?.focus({ preventScroll: true });
      selected?.scrollIntoView({ block: "nearest" });
    }
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, { passive: true });
  });
  function open() {
    if (search) search.value = "";
    render();
    if (search) options.scrollTop = 0;
    menu.showPopover({ source: trigger });
    position();
  }
  trigger.addEventListener("click", (event) => {
    event.preventDefault();
    if (isOpen()) menu.hidePopover();
    else open();
  });
  trigger.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    if (!isOpen()) open();
  });
  menu.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      menu.hidePopover();
      trigger.focus();
      return;
    }
    if (event.key === "Tab") {
      menu.hidePopover();
      trigger.focus();
      return;
    }
    const buttons = items();
    if (event.target === search) {
      if (event.key === "Enter" && buttons.length === 1) {
        event.preventDefault();
        buttons[0].click();
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        (event.key === "ArrowDown" ? buttons[0] : buttons.at(-1))?.focus();
      }
      return;
    }
    const current = buttons.indexOf(document.activeElement);
    const last = buttons.length - 1;
    const target = {
      ArrowDown: (current + 1) % buttons.length,
      ArrowUp: current > 0 ? current - 1 : last,
      Home: 0,
      End: last,
    }[event.key];
    if (typeof target !== "number") return;
    event.preventDefault();
    buttons[target]?.focus();
  });
  select.closest("details")?.addEventListener("toggle", (event) => {
    if (!event.currentTarget.open && isOpen()) menu.hidePopover();
  });
  select.addEventListener("change", render);
  new MutationObserver(() => {
    render();
    if (isOpen()) {
      if (search) filterOptions();
      else {
        position();
        options.querySelector('[aria-checked="true"]')?.focus();
      }
    }
  }).observe(select, { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled"] });
  render();

  return () => { if (isOpen()) menu.hidePopover(); };
}
