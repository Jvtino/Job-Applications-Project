const iconSprite = `
<svg xmlns="http://www.w3.org/2000/svg" style="position:absolute;width:0;height:0;overflow:hidden" aria-hidden="true" focusable="false">
  <symbol id="i-arrow-left" viewBox="0 0 24 24"><path d="M19 12H5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="m12 19-7-7 7-7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></symbol>
  <symbol id="i-arrow-right" viewBox="0 0 24 24"><path d="M5 12h14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="m12 5 7 7-7 7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></symbol>
  <symbol id="i-bell" viewBox="0 0 24 24"><path d="M18 8a6 6 0 1 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M13.7 21a2 2 0 0 1-3.4 0" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></symbol>
  <symbol id="i-board" viewBox="0 0 24 24"><path d="M4 5h16v14H4z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M9 5v14M15 5v14" fill="none" stroke="currentColor" stroke-width="1.8"/></symbol>
  <symbol id="i-check" viewBox="0 0 24 24"><path d="m20 6-11 11-5-5" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/></symbol>
  <symbol id="i-clock" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 7v5l3 2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></symbol>
  <symbol id="i-file" viewBox="0 0 24 24"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M14 3v6h6M8 13h8M8 17h5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></symbol>
  <symbol id="i-filter" viewBox="0 0 24 24"><path d="M4 6h16M7 12h10M10 18h4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></symbol>
  <symbol id="i-pause" viewBox="0 0 24 24"><path d="M9 5v14M15 5v14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></symbol>
  <symbol id="i-play" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></symbol>
  <symbol id="i-search" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="m16.5 16.5 4 4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></symbol>
  <symbol id="i-send" viewBox="0 0 24 24"><path d="m22 2-7 20-4-9-9-4z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M22 2 11 13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></symbol>
  <symbol id="i-settings" viewBox="0 0 24 24"><path d="M12 15.5A3.5 3.5 0 1 0 12 8a3.5 3.5 0 0 0 0 7.5Z" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 0 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2a2 2 0 0 1-4 0V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1A2 2 0 0 1 4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.6-1H3a2 2 0 0 1 0-4h.2a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.4 7A2 2 0 0 1 7.2 4.2l.1.1a1.7 1.7 0 0 0 1.9.3 1.7 1.7 0 0 0 1-1.6V3a2 2 0 0 1 4 0v.2a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1A2 2 0 0 1 20 7.2l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2a2 2 0 0 1 0 4h-.2a1.7 1.7 0 0 0-1.8.8Z" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linejoin="round"/></symbol>
  <symbol id="i-shield" viewBox="0 0 24 24"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="m9 12 2 2 4-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></symbol>
  <symbol id="i-spark" viewBox="0 0 24 24"><path d="M12 2 9.8 8.8 3 11l6.8 2.2L12 20l2.2-6.8L21 11l-6.8-2.2z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="m19 17 .7 2.3L22 20l-2.3.7L19 23l-.7-2.3L16 20l2.3-.7z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></symbol>
  <symbol id="i-star" viewBox="0 0 24 24"><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.1L12 17.1 6.4 20l1.1-6.1L3 9.6l6.2-.9z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></symbol>
  <symbol id="i-upload" viewBox="0 0 24 24"><path d="M12 15V3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="m7 8 5-5 5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M5 15v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></symbol>
</svg>`;

document.body.insertAdjacentHTML("afterbegin", iconSprite);

const toast = document.querySelector(".toast");
let toastTimer;

function showToast(message) {
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add("is-visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("is-visible"), 1800);
}

document.querySelectorAll("[data-toast]").forEach((button) => {
  button.addEventListener("click", () => showToast(button.dataset.toast));
});

const drawer = document.querySelector('[data-drawer-panel="job-detail"]');
const modal = document.querySelector('[data-modal-panel="one-click"]');
let activeModalCompany = "Application";
let modalOpenedFromDrawer = false;

function setOverlayState() {
  const drawerOpen = drawer?.classList.contains("is-open");
  const modalOpen = modal?.classList.contains("is-open");
  document.body.classList.toggle("overlay-open", Boolean(drawerOpen || modalOpen));
}

function openDrawer(trigger) {
  if (!drawer) return;
  const company = trigger.dataset.company || "Prepared company";
  const role = trigger.dataset.role || "Application packet";
  const title = drawer.querySelector("[data-drawer-title]");
  const companyLabel = drawer.querySelector("[data-drawer-company]");
  const oneClickButton = drawer.querySelector('[data-modal="one-click"]');

  if (title) title.textContent = role;
  if (companyLabel) companyLabel.textContent = company;
  if (oneClickButton) {
    oneClickButton.dataset.company = company;
    oneClickButton.dataset.role = role;
  }

  drawer.classList.add("is-open");
  drawer.setAttribute("aria-hidden", "false");
  setOverlayState();
}

function closeDrawer() {
  if (!drawer) return;
  drawer.classList.remove("is-open");
  drawer.setAttribute("aria-hidden", "true");
  setOverlayState();
}

function openModal(trigger) {
  if (!modal) return;
  const company = trigger.dataset.company || "Prepared application";
  const role = trigger.dataset.role || "Ready to apply";
  const title = modal.querySelector("[data-modal-title]");
  const companyLabel = modal.querySelector("[data-modal-company]");

  activeModalCompany = company;
  modalOpenedFromDrawer = Boolean(trigger.closest(".detail-drawer"));
  if (title) title.textContent = role;
  if (companyLabel) companyLabel.textContent = company;

  modal.classList.add("is-open");
  modal.setAttribute("aria-hidden", "false");
  setOverlayState();
}

function closeModal() {
  if (!modal) return;
  modal.classList.remove("is-open");
  modal.setAttribute("aria-hidden", "true");
  setOverlayState();
}

document.querySelectorAll("[data-drawer]").forEach((button) => {
  button.addEventListener("click", (event) => {
    event.preventDefault();
    openDrawer(button);
  });
});

document.querySelectorAll("[data-drawer-close]").forEach((button) => {
  button.addEventListener("click", closeDrawer);
});

document.querySelectorAll("[data-modal]").forEach((button) => {
  button.addEventListener("click", (event) => {
    event.preventDefault();
    openModal(button);
  });
});

document.querySelectorAll("[data-modal-close]").forEach((button) => {
  button.addEventListener("click", closeModal);
});

document.querySelectorAll("[data-modal-submit]").forEach((button) => {
  button.addEventListener("click", () => {
    closeModal();
    if (modalOpenedFromDrawer) closeDrawer();
    showToast(`${activeModalCompany} submitted and moved to Applied`);
  });
});

document.querySelectorAll("[data-toggle]").forEach((toggle) => {
  toggle.addEventListener("click", () => {
    toggle.classList.toggle("is-on");
    showToast(toggle.classList.contains("is-on") ? "Review gate enabled" : "Review gate paused");
  });
});

document.querySelectorAll(".segmented").forEach((group) => {
  group.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    group.querySelectorAll("button").forEach((item) => item.classList.remove("is-active"));
    button.classList.add("is-active");

    if (button.dataset.tab) {
      document.querySelectorAll("[data-tab-panel]").forEach((panel) => {
        panel.classList.toggle("is-active", panel.dataset.tabPanel === button.dataset.tab);
      });
    }
  });
});

document.querySelectorAll(".star-button, .mini-icon").forEach((button) => {
  if (button.dataset.drawer) return;
  button.addEventListener("click", () => {
    button.classList.toggle("active");
    showToast(button.classList.contains("active") ? "Saved" : "Removed");
  });
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  closeModal();
  closeDrawer();
});
