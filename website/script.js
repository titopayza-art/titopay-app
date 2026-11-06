const body = document.body;
const mobileToggle = document.querySelector(".mobile-toggle");
const mobilePanel = document.querySelector(".mobile-panel");
const toast = document.getElementById("toast");
let lockedScrollY = 0;
// Whether the mobile menu actually took the page out of flow, as opposed to
// whether the window happens to be narrow at the moment we ask.
let menuScrollLocked = false;

const contacts = {
  hello: "hello@titopay.co.za",
  support: "support@titopay.co.za",
  careers: "careers@titopay.co.za"
};

document.querySelectorAll(".nav-dropdown").forEach((dropdown) => {
  const button = dropdown.querySelector("button");
  const menu = dropdown.querySelector(".dropdown-menu");
  if (!button || !menu) return;

  button.setAttribute("aria-expanded", "false");
  button.setAttribute("aria-haspopup", "true");

  function setOpen(open) {
    dropdown.classList.toggle("open", open);
    button.setAttribute("aria-expanded", String(open));
  }

  button.addEventListener("click", (event) => {
    event.stopPropagation();
    setOpen(!dropdown.classList.contains("open"));
  });

  menu.querySelectorAll("a").forEach((link) => {
    link.addEventListener("click", () => setOpen(false));
  });

  document.addEventListener("click", (event) => {
    if (!dropdown.contains(event.target)) setOpen(false);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && dropdown.classList.contains("open")) {
      setOpen(false);
      button.focus();
    }
  });
  dropdown.addEventListener("focusout", event => {
    if (!dropdown.contains(event.relatedTarget)) setOpen(false);
  });
});

function showToast(message) {
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add("show");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.remove("show"), 3800);
}

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value).trim());
}

function serializeForm(form) {
  const data = {};
  new FormData(form).forEach((value, key) => {
    if (!(value instanceof File)) data[key] = value;
  });
  return data;
}

function readStoredList(key) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || "[]");
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function writeStoredList(key, value) {
  localStorage.setItem(key, JSON.stringify(Array.isArray(value) ? value : []));
}

function makeRecordId(prefix) {
  if (window.crypto && crypto.randomUUID) return `${prefix}-${crypto.randomUUID()}`;
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function collectApplicationAttachments(form) {
  const fields = [
    ["cvFile", "CV / Resume", true],
    ["qualificationFile", "Qualification documents", true],
    ["supportingFile", "Supporting documents", false]
  ];
  const maxSize = 4 * 1024 * 1024;
  const attachments = [];

  for (const [name, label, required] of fields) {
    const input = form.querySelector(`[name='${name}']`);
    const file = input && input.files && input.files[0];
    if (!file) {
      if (required) throw new Error(`Please upload your ${label.toLowerCase()}.`);
      continue;
    }
    if (file.size > maxSize) throw new Error(`${label} must be 4 MB or smaller.`);
    attachments.push({
      field: name,
      label,
      name: file.name,
      type: file.type || "application/octet-stream",
      size: file.size,
      dataUrl: await readFileAsDataUrl(file)
    });
  }

  return attachments;
}

function attachmentSummary(attachments) {
  return (attachments || []).map((file) => `${file.label}: ${file.name}`).join("\n");
}

function stripAttachmentData(candidate) {
  return {
    ...candidate,
    attachments: (candidate.attachments || []).map(({ dataUrl, ...file }) => file)
  };
}

async function sendApplicationToServer(candidate) {
  const response = await fetch("hr/submit-application.php", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(candidate)
  });
  if (response.status === 422 || response.status === 429) {
    // The endpoint answered and refused, so the applicant must be told rather
    // than shown a success message for an application HR never received.
    let reason = "This application could not be accepted.";
    try {
      const payload = await response.json();
      if (payload && payload.error) reason = String(payload.error);
    } catch {
      // Keep the generic reason when the body is not JSON.
    }
    const error = new Error(reason);
    error.serverRejected = true;
    throw error;
  }
  if (!response.ok) throw new Error("Application endpoint unavailable.");
  const result = await response.json();
  if (!result || result.ok !== true) throw new Error(result?.error || "We couldn’t confirm receipt. Please try again.");
  return result;
}

function showFormFailure(form, message) {
  let feedback = form.querySelector('[data-form-feedback]');
  if (!feedback) {
    feedback = document.createElement('p');
    feedback.dataset.formFeedback = 'true';
    feedback.className = 'form-feedback';
    feedback.setAttribute('role', 'alert');
    form.appendChild(feedback);
  }
  feedback.textContent = message;
}

async function withSubmissionState(form, task) {
  if (form.dataset.sending === "true") throw new Error("Your request is still being sent. Please wait.");
  form.dataset.sending = "true";
  const feedback = form.querySelector("[data-form-feedback]");
  if (feedback) feedback.textContent = "";
  const button = form.querySelector('button[type="submit"]');
  const label = button?.innerHTML;
  if (button) { button.disabled = true; button.textContent = "Sending…"; }
  try { return await task(); }
  finally {
    delete form.dataset.sending;
    if (button) { button.disabled = false; button.innerHTML = label; }
  }
}

async function submitPublicForm(payload) {
  const response = await fetch("api/submit-form.php", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    // The endpoint answered and refused. That is a real answer, not a missing
    // backend, so the caller must show it instead of reporting success.
    let reason = "We couldn’t send your request. Your details are still here; please try again or contact us on WhatsApp.";
    try {
      const payload = await response.json();
      if (payload && payload.error) reason = String(payload.error);
    } catch {
      // Keep the generic reason when the body is not JSON.
    }
    const error = new Error(reason);
    error.serverRejected = true;
    throw error;
  }
  const result = await response.json();
  if (!result || result.ok !== true) throw new Error(result?.error || "We couldn’t confirm receipt. Please try again.");
  return result;
}

if (mobileToggle && mobilePanel) {
  const shouldLockMobileScroll = () => window.matchMedia("(max-width: 680px) and (pointer: coarse)").matches;

  function openMobileMenu() {
    if (shouldLockMobileScroll()) {
      lockedScrollY = window.scrollY || document.documentElement.scrollTop || 0;
      body.style.setProperty("--menu-scroll-lock-top", `-${lockedScrollY}px`);
      // Remember that we locked, rather than working it out again at close
      // time from the window width. The width can change while the menu is
      // open -- that is exactly what the resize handler below reacts to -- and
      // asking "is this a narrow window NOW?" then answers no, the restore is
      // skipped, and the reader is dropped at the top of the page having lost
      // wherever they had read to.
      menuScrollLocked = true;
    }
    body.classList.add("menu-open");
    mobileToggle.setAttribute("aria-expanded", "true");
    mobileToggle.setAttribute("aria-label", "Close menu");
    mobileToggle.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>';
  }

  function closeMobileMenu() {
    const restoreScroll = menuScrollLocked && body.classList.contains("menu-open");
    menuScrollLocked = false;
    body.classList.remove("menu-open");
    body.style.removeProperty("--menu-scroll-lock-top");
    mobileToggle.setAttribute("aria-expanded", "false");
    mobileToggle.setAttribute("aria-label", "Open menu");
    mobileToggle.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>';
    if (restoreScroll) window.scrollTo(0, lockedScrollY);
  }

  mobileToggle.addEventListener("click", () => {
    if (body.classList.contains("menu-open")) closeMobileMenu();
    else openMobileMenu();
  });

  mobilePanel.querySelectorAll("a").forEach((link) => {
    link.addEventListener("click", () => {
      closeMobileMenu();
    });
  });

  window.addEventListener("resize", () => {
    if (window.matchMedia("(min-width: 1121px)").matches && body.classList.contains("menu-open")) {
      closeMobileMenu();
    }
  });
}

document.querySelectorAll("[data-waitlist-form]").forEach((form) => {
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = serializeForm(form);

    if (String(data.website || "").trim()) {
      form.reset();
      showToast("Thank you. Your request has been received.");
      return;
    }

    if (!data.name || !isEmail(data.email) || !data.interest) {
      showToast("Please add your name, a valid email address, and your waitlist interest.");
      return;
    }

    if (!data.privacyConsent) {
      showToast("Please accept the privacy consent to join the waitlist.");
      return;
    }

    const record = {
      name: data.name,
      email: data.email,
      phone: data.phone || "",
      interest: data.interest,
      context: form.dataset.context || "website",
      destination: form.dataset.email || contacts.hello,
      timestamp: new Date().toISOString()
    };

    let serverSubmission = null;
    try {
      serverSubmission = await withSubmissionState(form, () => submitPublicForm({ formType: "waitlist", ...record }));
    } catch (error) {
      showFormFailure(form, error.message || "We couldn’t send your request. Your details are still here; please try again.");
      return;
    }


    form.reset();
    const ticketNumber = serverSubmission?.submission?.ticket_number;
    showToast(ticketNumber ? `Thank you. Your TitoPay waitlist ticket is ${ticketNumber}.` : "Thank you. Your TitoPay waitlist request has been received.");
  });
});

document.querySelectorAll("[data-contact-form]").forEach((contactForm) => {
  contactForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = serializeForm(contactForm);

    if (String(data.website || "").trim()) {
      contactForm.reset();
      showToast("Thank you. Your request has been received.");
      return;
    }

    if (!data.name || !isEmail(data.email) || !data.type || String(data.message || "").trim().length < 8) {
      showToast("Please complete the form with a valid email address and message.");
      return;
    }

    if (!data.privacyConsent) {
      showToast("Please accept the privacy consent to send this request.");
      return;
    }

    const lowerType = String(data.type).toLowerCase();
    const route = contactForm.dataset.route || "hello";
    let to = contactForm.dataset.email || contacts[route] || contacts.hello;
    if (route === "hello" && (lowerType.includes("support") || lowerType.includes("security") || lowerType.includes("refund") || lowerType.includes("privacy") || lowerType.includes("vulnerability") || lowerType.includes("legal") || lowerType.includes("popia"))) {
      to = contacts.support;
    }
    if (route === "careers") to = contacts.careers;

    const record = {
      name: data.name,
      email: data.email,
      phone: data.phone || "",
      requestType: data.type,
      message: data.message,
      route,
      destination: to,
      context: contactForm.dataset.context || contactForm.dataset.route || "website",
      timestamp: new Date().toISOString()
    };

    let serverSubmission = null;
    try {
      serverSubmission = await withSubmissionState(contactForm, () => submitPublicForm({ formType: "contact", ...record }));
    } catch (error) {
      showFormFailure(contactForm, error.message || "We couldn’t send your request. Your details are still here; please try again.");
      return;
    }


    contactForm.reset();
    const ticketNumber = serverSubmission?.submission?.ticket_number;
    showToast(ticketNumber ? `Thank you. Your TitoPay ticket is ${ticketNumber}.` : "Thank you. Your TitoPay request has been received.");
  });
});

document.querySelectorAll("[data-apply-role]").forEach((button) => {
  button.addEventListener("click", () => {
    const form = document.querySelector("[data-application-form]");
    if (!form) return;
    const role = button.dataset.applyRole || "";
    const select = form.querySelector("[name='role']");
    if (select) select.value = role;
    const target = document.getElementById("career-application-section") || form;
    const headerHeight = document.querySelector(".site-header")?.getBoundingClientRect().height || 0;
    const targetTop = target.getBoundingClientRect().top + window.scrollY - headerHeight - 16;
    window.scrollTo({ top: Math.max(0, targetTop), behavior: "auto" });
    const firstInput = form.querySelector("input, select, textarea");
    window.setTimeout(() => {
      if (firstInput) firstInput.focus({ preventScroll: true });
    }, 80);
    showToast(`Selected ${role}. Complete the application form below.`);
  });
});

document.querySelectorAll("[data-application-form]").forEach((applicationForm) => {
  applicationForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = serializeForm(applicationForm);

    if (!data.name || !isEmail(data.email) || !data.role || !data.phone) {
      showToast("Please add your name, email address, phone number, and selected role.");
      return;
    }

    let attachments = [];
    try {
      attachments = await collectApplicationAttachments(applicationForm);
    } catch (error) {
      showToast(error.message || "Please upload the required application documents.");
      return;
    }

    const submittedAt = new Date().toISOString();
    const record = {
      ...data,
      attachments: stripAttachmentData({ attachments }).attachments,
      context: applicationForm.dataset.context || "careers",
      timestamp: submittedAt
    };


    const candidateNotes = [
      data.message && `Motivation: ${data.message}`,
      data.phone && `Phone: ${data.phone}`,
      data.qualification && `Qualification: ${data.qualification}`,
      data.portfolio && `LinkedIn / portfolio: ${data.portfolio}`,
      data.workAuth && `Work eligibility: ${data.workAuth}`,
      attachments.length && `Attachments:\n${attachmentSummary(attachments)}`,
      `Submitted via TitoPay marketing website on ${submittedAt.slice(0, 10)}.`
    ].filter(Boolean).join("\n");

    const candidateRecord = {
      id: makeRecordId("candidate"),
      name: data.name,
      email: data.email,
      jobTitle: data.role,
      stage: "screening",
      notes: candidateNotes,
      status: "active",
      source: "Marketing website",
      phone: data.phone || "",
      qualification: data.qualification || "",
      portfolio: data.portfolio || "",
      attachments,
      createdAt: submittedAt,
      updatedAt: submittedAt
    };

    let serverApplication = null;
    try {
      serverApplication = await withSubmissionState(applicationForm, () => sendApplicationToServer(candidateRecord));
    } catch (error) {
      showFormFailure(applicationForm, error.message || "We couldn’t send your application. Your details are still here; please try again.");
      return;
    }

    applicationForm.reset();
    const applicationNumber = serverApplication?.candidate?.application_number || serverApplication?.application?.application_number;
    showToast(applicationNumber ? `Application received. Your TitoPay application number is ${applicationNumber}.` : "Thank you. Your application has been received.");
  });
});

function initPrivacyPreferences() {
  const storageKey = "titopayPrivacyPreferences";

  function readPreferences() {
    try {
      const value = JSON.parse(localStorage.getItem(storageKey) || "null");
      return value && typeof value === "object" ? value : null;
    } catch {
      return null;
    }
  }

  function savePreferences(preferences) {
    const value = {
      necessary: true,
      analytics: Boolean(preferences.analytics),
      marketing: Boolean(preferences.marketing),
      updatedAt: new Date().toISOString()
    };
    localStorage.setItem(storageKey, JSON.stringify(value));
    window.dispatchEvent(new CustomEvent("titopay:privacy-preferences", { detail: value }));
    return value;
  }

  // The panel says aria-modal="true", so it has to behave like one: the page
  // behind it must not scroll, and Escape must close it. Neither was true --
  // it could only be dismissed by the close button or a backdrop click, which
  // is a dead end for anyone reaching for the key every other dialog answers.
  //
  // The lock goes on <html>, not <body>. Locking the body would make it a
  // scroll container again, which is the thing that froze the wheel on this
  // site in the first place.
  let panelEscape = null;

  function unlockBehindPanel() {
    document.documentElement.classList.remove("privacy-locked");
    if (panelEscape) {
      document.removeEventListener("keydown", panelEscape);
      panelEscape = null;
    }
  }

  function closePanel() {
    document.querySelector("[data-privacy-panel]")?.remove();
    unlockBehindPanel();
  }

  function closeBanner() {
    document.querySelector("[data-privacy-banner]")?.remove();
  }

  function openPanel() {
    closePanel();
    const saved = readPreferences() || { analytics: false, marketing: false };
    const panel = document.createElement("section");
    panel.className = "privacy-panel";
    panel.dataset.privacyPanel = "true";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-labelledby", "privacy-panel-title");
    panel.innerHTML = `
      <div class="privacy-dialog">
        <button class="privacy-close" type="button" aria-label="Close cookie settings">×</button>
        <span class="label">Your choices</span>
        <h2 id="privacy-panel-title">Cookie settings</h2>
        <p>Choose how TitoPay may use optional cookies and browser storage. Essential storage keeps forms, security checks, and preference choices working. Optional categories are off unless you allow them.</p>
        <div class="privacy-options">
          <label class="privacy-option is-required">
            <span><strong>Essential</strong><small>Required for site security, forms, and remembering this choice.</small></span>
            <input type="checkbox" checked disabled>
          </label>
          <label class="privacy-option">
            <span><strong>Analytics</strong><small>Help us understand how the site is used, when analytics is enabled.</small></span>
            <input name="analytics" type="checkbox"${saved.analytics ? " checked" : ""}>
          </label>
          <label class="privacy-option">
            <span><strong>Marketing updates</strong><small>Allows TitoPay to remember communication preferences for product and app updates.</small></span>
            <input name="marketing" type="checkbox"${saved.marketing ? " checked" : ""}>
          </label>
        </div>
        <div class="privacy-actions">
          <button class="btn btn-primary" type="button" data-privacy-save>Save preferences</button>
          <button class="btn btn-secondary" type="button" data-privacy-essential>Essential only</button>
        </div>
        <a class="text-link" href="legal#legal-privacy">Read TitoPay privacy policy</a>
      </div>
    `;
    document.body.appendChild(panel);
    document.documentElement.classList.add("privacy-locked");
    panelEscape = (event) => {
      if (event.key === "Escape" || event.key === "Esc") closePanel();
    };
    document.addEventListener("keydown", panelEscape);
    const firstInput = panel.querySelector("input[name='analytics']");
    if (firstInput) firstInput.focus({ preventScroll: true });

    panel.querySelector(".privacy-close")?.addEventListener("click", closePanel);
    panel.addEventListener("click", (event) => {
      if (event.target === panel) closePanel();
    });
    panel.querySelector("[data-privacy-save]")?.addEventListener("click", () => {
      savePreferences({
        analytics: panel.querySelector("input[name='analytics']")?.checked,
        marketing: panel.querySelector("input[name='marketing']")?.checked
      });
      closeBanner();
      closePanel();
      showToast("Your Cookie settings have been saved.");
    });
    panel.querySelector("[data-privacy-essential]")?.addEventListener("click", () => {
      savePreferences({ analytics: false, marketing: false });
      closeBanner();
      closePanel();
      showToast("Essential-only privacy preferences have been saved.");
    });
  }

  function showBanner() {
    if (readPreferences() || document.querySelector("[data-privacy-banner]")) return;
    const banner = document.createElement("section");
    banner.className = "privacy-banner";
    banner.dataset.privacyBanner = "true";
    banner.setAttribute("aria-label", "Cookie settings");
    banner.innerHTML = `
      <div class="privacy-banner-copy">
        <span class="label">Privacy</span>
        <h2>TitoPay respects your privacy.</h2>
        <p>We use essential cookies and browser storage for site security, forms, and remembering your preferences. Optional analytics or marketing storage is only used if you allow it.</p>
      </div>
      <div class="privacy-banner-actions">
        <button class="btn btn-primary" type="button" data-privacy-accept>Accept all</button>
        <button class="btn btn-secondary" type="button" data-privacy-manage>Manage cookies</button>
        <button class="privacy-link-button" type="button" data-privacy-essential>Essential only</button>
      </div>
    `;
    document.body.appendChild(banner);
    banner.querySelector("[data-privacy-accept]")?.addEventListener("click", () => {
      savePreferences({ analytics: true, marketing: true });
      closeBanner();
      showToast("All Cookie settings have been accepted.");
    });
    banner.querySelector("[data-privacy-manage]")?.addEventListener("click", openPanel);
    banner.querySelector("[data-privacy-essential]")?.addEventListener("click", () => {
      savePreferences({ analytics: false, marketing: false });
      closeBanner();
      showToast("Essential-only privacy preferences have been saved.");
    });
  }

  document.querySelectorAll(".footer-simple").forEach((footer) => {
    if (footer.querySelector("[data-privacy-open]")) return;
    const button = document.createElement("button");
    button.className = "footer-privacy-button";
    button.type = "button";
    button.dataset.privacyOpen = "true";
    button.textContent = "Cookie settings";
    button.addEventListener("click", openPanel);
    footer.appendChild(button);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closePanel();
  });

  showBanner();
}

function initSupportChat() {
  if (document.querySelector("[data-support-chat]")) return;

  const chatStorageKey = "titopaySupportChatId";

  /*
   * Tito, the TitoPay virtual assistant, answers from this list only. Every answer repeats
   * what the website and legal pages already say, so the assistant can never
   * promise something the site does not. Anything it cannot answer is handed
   * to the TitoPay team through the existing admin chat and ticket process.
   */
  const knowledge = [
    {
      id: "launch",
      label: "When is TitoPay launching?",
      keywords: ["launch", "launching", "when", "live", "release", "date", "available", "start", "ready", "open"],
      answer: "The TitoPay app is available at app.titopay.co.za. Create your personal wallet or choose Business to follow the business account setup steps.",
      link: "https://app.titopay.co.za", linkText: "Create your wallet",
      next: ["download", "fees", "what"]
    },
    {
      id: "waitlist",
      label: "How do I create my wallet?",
      keywords: ["waitlist", "wait", "list", "join", "sign", "signup", "register", "early", "access", "reserve"],
      answer: "Open app.titopay.co.za, choose Create Account or Create Business Account and follow the setup steps. There are zero signup fees and zero monthly wallet fees.",
      link: "https://app.titopay.co.za", linkText: "Create your wallet",
      next: ["fees", "launch", "business"]
    },
    {
      id: "fees",
      label: "What does it cost?",
      keywords: ["fee", "fees", "cost", "costs", "free", "price", "pricing", "charge", "charges", "monthly", "pay", "much", "expensive", "r0"],
      answer: "Registration, monthly wallet access and transfers between TitoPay wallets are free. Other charges may apply and will be shown before you pay.",
      next: ["what", "waitlist", "safe"]
    },
    {
      id: "what",
      label: "What can I do with TitoPay?",
      keywords: ["what", "do", "does", "wallet", "features", "send", "receive", "bills", "shop", "transfer", "money", "use", "work", "works", "how", "titopay", "about", "explain"],
      answer: "TitoPay is a digital wallet for everyday South Africa. Open the app to send, pay and get paid. Check your account for available services, payment options and requirements.",
      link: "personal", linkText: "See the personal wallet",
      next: ["fees", "business", "download"]
    },
    {
      id: "download",
      label: "Where can I download the app?",
      keywords: ["download", "app", "install", "android", "iphone", "ios", "play", "store", "apple", "phone"],
      answer: "Open app.titopay.co.za in Safari on iPhone or Chrome on Android. Use Add to Home Screen or Install from the browser menu. Our Get the app page has step-by-step instructions.",
      link: "install", linkText: "Save TitoPay to your phone",
      next: ["launch", "fees", "what"]
    },
    {
      id: "bank",
      label: "Is TitoPay a bank?",
      keywords: ["bank", "banking", "regulated", "licence", "license", "licensed", "fsca", "sarb", "regulation", "account"],
      answer: "TitoPay is not a bank. It is a South African fintech company building a digital wallet and payment platform. Details about our banking and regulatory partners will be shared through official TitoPay channels as services become available.",
      next: ["safe", "fees", "what"]
    },
    {
      id: "safe",
      label: "Is TitoPay safe?",
      keywords: ["safe", "secure", "security", "safety", "trust", "protected", "encrypted", "fraud", "legit", "legitimate"],
      answer: "Use the official app address app.titopay.co.za and never share your PIN, password or OTP. See our security page for guidance and reporting concerns.",
      link: "security", linkText: "Visit the Security Center",
      next: ["scam", "privacy", "bank"]
    },
    {
      id: "scam",
      label: "Report a scam or security concern",
      keywords: ["scam", "scammer", "fraudster", "hacked", "phishing", "otp", "pin", "password", "stolen", "suspicious", "impersonat", "fake", "concern"],
      answer: "Never share your PIN, password, OTP or verification code with anyone, including someone who says they are from TitoPay. If something looks suspicious, stop and speak to the TitoPay team right away.",
      topic: "Security concern",
      link: "security", linkText: "Visit the Security Center",
      next: ["safe", "privacy"]
    },
    {
      id: "privacy",
      label: "How is my data used?",
      keywords: ["privacy", "data", "popia", "personal", "information", "sell", "cookies", "delete", "details"],
      answer: "TitoPay handles your personal information under POPIA and does not sell personal information. You can read exactly what we collect and why in our privacy policy.",
      link: "legal", linkText: "Read the privacy policy",
      next: ["safe", "bank"]
    },
    {
      id: "business",
      label: "TitoPay for my business",
      keywords: ["business", "merchant", "shop", "spaza", "store", "sme", "trader", "qr", "accept", "sell", "settlement", "onboarding", "company"],
      answer: "Open app.titopay.co.za and select Business to create a business account. Follow the app for available payment tools and any account requirements.",
      link: "business", linkText: "See business payments",
      topic: "Business onboarding",
      next: ["fees", "waitlist", "events"]
    },
    {
      id: "events",
      label: "TitoPay Events",
      keywords: ["event", "events", "festival", "concert", "organiser", "organizer", "vendor", "cashless", "ticket", "tickets", "conference"],
      answer: "TitoPay Events is a planned service for organisers and vendors. Contact the team to discuss your event, costs and availability.",
      link: "events", linkText: "Open TitoPay Events",
      topic: "TitoPay Events enquiry",
      next: ["business", "launch"]
    },
    {
      id: "careers",
      label: "Is TitoPay hiring?",
      keywords: ["job", "jobs", "career", "careers", "hiring", "vacancy", "vacancies", "work", "apply", "cv", "internship"],
      answer: "Open roles are listed on the Careers page, where you can apply with your CV and qualifications.",
      link: "careers", linkText: "View careers",
      next: ["what", "contact"]
    },
    {
      id: "contact",
      label: "How do I contact TitoPay?",
      keywords: ["contact", "call", "phone", "number", "whatsapp", "email", "reach", "speak", "support", "help"],
      answer: "You can call or WhatsApp TitoPay on +27 72 667 1183, use the contact form, or leave a message for the team right here.",
      link: "contact", linkText: "Open the contact page",
      next: ["waitlist", "launch"]
    }
  ];
  const byId = Object.fromEntries(knowledge.map((item) => [item.id, item]));
  const starters = ["launch", "fees", "waitlist"];
  const humanWords = ["human", "person", "agent", "consultant", "operator", "callback", "call me back", "talk to someone", "speak to someone", "talk to a person", "real person"];
  const greetingWords = ["hi", "hello", "hey", "howzit", "sawubona", "molo", "dumela", "good morning", "good afternoon", "good evening"];
  const thanksWords = ["thanks", "thank you", "thank", "cheers", "appreciate", "great", "awesome", "ok", "okay", "cool"];

  let currentChatId = localStorage.getItem(chatStorageKey) || "";
  let pollTimer = null;
  let lastTopic = "General support";
  // Tito tries to help first: the team is only offered once Tito has answered
  // something, could not answer, or the visitor asks for a person twice.
  let titoHasTried = false;
  let humanRequests = 0;
  const askedQuestions = [];

  const widget = document.createElement("section");
  widget.className = "support-chat";
  widget.dataset.supportChat = "true";
  widget.innerHTML = `
    <button class="support-chat-launcher" type="button" aria-expanded="false" aria-controls="support-chat-panel">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z"/></svg>
      <span>Ask Tito</span>
    </button>
    <div class="support-chat-panel" id="support-chat-panel" role="dialog" aria-label="Chat with Tito, the TitoPay virtual assistant" aria-hidden="true">
      <div class="support-chat-header">
        <div class="support-chat-identity">
          <span class="support-chat-avatar" aria-hidden="true">T</span>
          <div>
            <h2>Tito</h2>
            <small>TitoPay&rsquo;s virtual assistant</small>
          </div>
        </div>
        <button class="support-chat-close" type="button" aria-label="Close chat">×</button>
      </div>
      <div class="support-chat-body" data-chat-body>
        <div class="bot-thread" data-bot-thread aria-live="polite"></div>
        <div class="bot-chips" data-bot-chips></div>
        <form class="support-chat-form" data-chat-start-form hidden>
          <input name="website" type="text" tabindex="-1" autocomplete="off" aria-hidden="true">
          <label><span>Name</span><input name="name" autocomplete="name" required></label>
          <label><span>Email</span><input name="email" type="email" autocomplete="email" required></label>
          <label class="full"><span>Contact number</span><input name="phone" type="tel" autocomplete="tel" placeholder="+27"></label>
          <label class="full"><span>Your message</span><textarea name="message" required></textarea></label>
          <label class="support-chat-check full"><input name="callback" type="checkbox"> <span>Please call me back instead</span></label>
          <div class="support-chat-form-actions full">
            <button class="btn btn-secondary" type="button" data-chat-cancel>Back</button>
            <button class="btn btn-primary" type="submit" data-chat-submit>Send message</button>
          </div>
        </form>
        <div class="support-chat-live" data-chat-live hidden>
          <div class="support-chat-reference" data-chat-reference></div>
          <div class="support-chat-messages" data-chat-messages aria-live="polite"></div>
          <form class="support-chat-reply" data-chat-reply-form>
            <input name="message" placeholder="Reply to the TitoPay team..." autocomplete="off" required>
            <button class="btn btn-primary" type="submit">Send</button>
          </form>
          <button class="bot-link-button" type="button" data-chat-new>Ask the assistant something else</button>
        </div>
      </div>
      <form class="bot-composer" data-bot-form>
        <input name="question" placeholder="Type your question…" autocomplete="off" aria-label="Ask Tito a question" maxlength="300">
        <button type="submit" aria-label="Send question"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m22 2-7 20-4-9-9-4 20-7Z"/><path d="m22 2-11 11"/></svg></button>
      </form>
    </div>
  `;
  document.body.appendChild(widget);

  const launcher = widget.querySelector(".support-chat-launcher");
  const panel = widget.querySelector(".support-chat-panel");
  const closeButton = widget.querySelector(".support-chat-close");
  const body = widget.querySelector("[data-chat-body]");
  const thread = widget.querySelector("[data-bot-thread]");
  const chips = widget.querySelector("[data-bot-chips]");
  const botForm = widget.querySelector("[data-bot-form]");
  const startForm = widget.querySelector("[data-chat-start-form]");
  const liveWrap = widget.querySelector("[data-chat-live]");
  const referenceBox = widget.querySelector("[data-chat-reference]");
  const messagesBox = widget.querySelector("[data-chat-messages]");
  const replyForm = widget.querySelector("[data-chat-reply-form]");
  const submitButton = widget.querySelector("[data-chat-submit]");

  function scrollToEnd() {
    body.scrollTop = body.scrollHeight;
  }

  function addBubble(from, text, item) {
    const bubble = document.createElement("div");
    bubble.className = `bot-bubble is-${from}`;
    const copy = document.createElement("p");
    copy.textContent = text;
    bubble.appendChild(copy);
    if (item?.link) {
      const link = document.createElement("a");
      link.className = "text-link";
      link.href = item.link;
      link.textContent = item.linkText || "Open page";
      bubble.appendChild(link);
    }
    thread.appendChild(bubble);
    scrollToEnd();
  }

  function setChips(ids, offerHuman) {
    chips.textContent = "";
    ids.map((id) => byId[id]).filter(Boolean).forEach((item) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "support-chat-faq";
      button.textContent = item.label;
      button.addEventListener("click", () => ask(item.label, item));
      chips.appendChild(button);
    });
    if (offerHuman) {
      const human = document.createElement("button");
      human.type = "button";
      human.className = "support-chat-faq is-human";
      human.textContent = "Talk to the TitoPay team";
      human.addEventListener("click", () => {
        addBubble("user", "Talk to the TitoPay team");
        showHandoff();
      });
      chips.appendChild(human);
    }
  }

  function normalise(text) {
    return ` ${String(text).toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim()} `;
  }

  function hasAny(text, words) {
    return words.some((word) => text.includes(` ${word} `) || (word.includes(" ") && text.includes(word)));
  }

  // Everyday words only count a little; distinctive words (fee, bank, scam)
  // count fully and also match longer forms ("scammed", "fees").
  const weakWords = ["what", "do", "does", "how", "when", "use", "work", "works", "money", "pay", "open", "start", "ready",
    "available", "list", "wait", "sign", "much", "personal", "details", "information", "account", "phone", "number", "help",
    "support", "apply", "store", "shop", "sell", "accept", "company", "play", "apple", "trust", "titopay", "about", "date", "release", "live"];

  function bestMatch(text) {
    let best = null;
    let bestScore = 0;
    knowledge.forEach((item) => {
      let score = 0;
      item.keywords.forEach((keyword) => {
        const weak = weakWords.includes(keyword);
        if (text.includes(` ${keyword} `)) score += weak ? 1 : 2;
        else if (!weak && keyword.length >= 4 && text.includes(keyword)) score += 2;
      });
      if (score > bestScore) {
        best = item;
        bestScore = score;
      }
    });
    return bestScore >= 2 ? best : null;
  }

  function ask(question, known) {
    const text = String(question || "").trim();
    if (!text) return;
    addBubble("user", text);
    askedQuestions.push(text);
    const clean = normalise(text);

    // Give the reply a beat so it reads as a conversation, not a page jump.
    window.setTimeout(() => {
      if (!known && hasAny(clean, humanWords)) {
        humanRequests += 1;
        if (!titoHasTried && humanRequests === 1) {
          addBubble("bot", "I can connect you with the TitoPay team. First, tell me what your question is about. I can often answer straight away.");
          setChips(starters, false);
          return;
        }
        showHandoff();
        return;
      }
      if (!known && hasAny(clean, greetingWords) && clean.trim().split(" ").length <= 4) {
        addBubble("bot", "Hi there! I can answer questions about TitoPay, account setup, fees, security and business payments. What would you like to know?");
        setChips(starters, titoHasTried);
        return;
      }
      if (!known && hasAny(clean, thanksWords) && clean.trim().split(" ").length <= 4) {
        addBubble("bot", "You're welcome. Is there anything else I can help with?");
        setChips(starters.slice(0, 4), titoHasTried);
        return;
      }
      const item = known || bestMatch(clean);
      if (!item) {
        addBubble("bot", "I'm not sure about that one yet. I can pass your question to the TitoPay team and they'll reply to you directly.");
        lastTopic = "General support";
        titoHasTried = true;
        setChips(starters.slice(0, 3), true);
        return;
      }
      if (item.topic) lastTopic = item.topic;
      addBubble("bot", item.answer, item);
      titoHasTried = true;
      setChips(item.next || starters, true);
    }, 280);
  }

  function showHandoff() {
    addBubble("bot", "Sure. Leave your details below and a TitoPay team member will reply here and by email.");
    chips.textContent = "";
    const message = startForm.querySelector("[name='message']");
    if (message && !message.value) {
      const lastQuestion = askedQuestions.filter((q) => q !== "Talk to the TitoPay team").slice(-1)[0] || "";
      message.value = lastQuestion;
    }
    startForm.hidden = false;
    botForm.hidden = true;
    startForm.querySelector("[name='name']")?.focus({ preventScroll: true });
    scrollToEnd();
  }

  function hideHandoff() {
    startForm.hidden = true;
    botForm.hidden = false;
    setChips(starters, titoHasTried);
    scrollToEnd();
  }

  function greet() {
    thread.textContent = "";
    titoHasTried = false;
    humanRequests = 0;
    addBubble("bot", "Hi, I’m Tito. How can I help?");
    setChips(starters, false);
  }

  /*
   * On phones Tito opens full screen. The page behind is frozen so it cannot
   * scroll under the chat, and the panel is sized to the visible viewport so
   * the on-screen keyboard never pushes the header out of view.
   */
  const phoneQuery = window.matchMedia("(max-width: 680px)");
  const finePointer = window.matchMedia("(pointer: fine)");
  let lockedScrollY = 0;
  let pageLocked = false;

  function fitToViewport() {
    const viewport = window.visualViewport;
    if (!viewport || !pageLocked) return;
    widget.style.setProperty("--tito-vv-height", `${Math.round(viewport.height)}px`);
    widget.style.setProperty("--tito-vv-top", `${Math.round(viewport.offsetTop)}px`);
    scrollToEnd();
  }

  function lockPage() {
    if (pageLocked || !phoneQuery.matches || finePointer.matches) return;
    lockedScrollY = window.scrollY;
    document.body.style.setProperty("--tito-scroll-lock-top", `-${lockedScrollY}px`);
    document.documentElement.classList.add("tito-open");
    document.body.classList.add("tito-open");
    pageLocked = true;
    document.addEventListener("touchstart", onTouchStart, { passive: true });
    document.addEventListener("touchmove", onTouchMove, { passive: false });
    fitToViewport();
  }

  function unlockPage() {
    if (!pageLocked) return;
    document.documentElement.classList.remove("tito-open");
    document.body.classList.remove("tito-open");
    document.body.style.removeProperty("--tito-scroll-lock-top");
    widget.style.removeProperty("--tito-vv-height");
    widget.style.removeProperty("--tito-vv-top");
    pageLocked = false;
    document.removeEventListener("touchstart", onTouchStart, { passive: true });
    document.removeEventListener("touchmove", onTouchMove, { passive: false });
    window.scrollTo(0, lockedScrollY);
  }

  /*
   * iPhone Safari lets a swipe that reaches the end of the chat carry on and
   * move the page underneath, even with the page frozen. While Tito is open
   * on a phone, a swipe may only scroll the conversation itself, and only
   * while there is still room to scroll in that direction.
   */
  let touchStartY = 0;
  function onTouchStart(event) {
    touchStartY = event.touches[0]?.clientY || 0;
  }
  // Registered only while Tito is full screen on a phone (see lockPage), so
  // the rest of the time the site has no page-wide touch handlers at all.
  function onTouchMove(event) {
    if (!pageLocked) return;
    const scroller = event.target instanceof Element
      ? event.target.closest(".support-chat-messages, .support-chat-body")
      : null;
    if (!scroller || !widget.contains(scroller)) {
      event.preventDefault();
      return;
    }
    const deltaY = (event.touches[0]?.clientY || 0) - touchStartY;
    const atTop = scroller.scrollTop <= 0;
    const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1;
    const cannotScroll = scroller.scrollHeight <= scroller.clientHeight;
    if (cannotScroll || (atTop && deltaY > 0) || (atBottom && deltaY < 0)) event.preventDefault();
  }

  // Mouse wheel and trackpad: the same rule on every screen size. Wheeling
  // over Tito scrolls the conversation and never the page behind it.
  panel.addEventListener("wheel", (event) => {
    if (!widget.classList.contains("is-open")) return;
    const scroller = event.target instanceof Element
      ? event.target.closest(".support-chat-messages, .support-chat-body")
      : null;
    if (!scroller) {
      event.preventDefault();
      return;
    }
    const atTop = scroller.scrollTop <= 0;
    const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1;
    const cannotScroll = scroller.scrollHeight <= scroller.clientHeight;
    if (cannotScroll || (atTop && event.deltaY < 0) || (atBottom && event.deltaY > 0)) event.preventDefault();
  }, { passive: false });

  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", fitToViewport);
    window.visualViewport.addEventListener("scroll", fitToViewport);
  }
  phoneQuery.addEventListener?.("change", () => {
    if (!widget.classList.contains("is-open")) return;
    if (phoneQuery.matches) lockPage();
    else unlockPage();
  });

  function openChat() {
    widget.classList.add("is-open");
    launcher.setAttribute("aria-expanded", "true");
    panel.setAttribute("aria-hidden", "false");
    lockPage();
    scrollToEnd();
    if (currentChatId) pollChat();
    // Only jump into the text box with a mouse or trackpad. On a phone the
    // keyboard stays down until the visitor taps the box themselves.
    else if (!botForm.hidden && finePointer.matches) botForm.querySelector("input")?.focus({ preventScroll: true });
  }

  function closeChat() {
    widget.classList.remove("is-open");
    launcher.setAttribute("aria-expanded", "false");
    panel.setAttribute("aria-hidden", "true");
    unlockPage();
  }

  async function chatRequest(payload) {
    const response = await fetch("api/chat.php", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok) throw new Error(result.error || "The TitoPay team chat is currently unavailable.");
    return result;
  }

  function showLive() {
    thread.hidden = true;
    chips.hidden = true;
    startForm.hidden = true;
    botForm.hidden = true;
    liveWrap.hidden = false;
  }

  function showAssistant() {
    liveWrap.hidden = true;
    thread.hidden = false;
    chips.hidden = false;
    botForm.hidden = false;
    startForm.hidden = true;
  }

  function renderMessages(payload) {
    if (!payload?.chat) return;
    currentChatId = payload.chat.id || currentChatId;
    localStorage.setItem(chatStorageKey, currentChatId);
    showLive();
    const status = payload.chat.status === "closed" ? "closed" : "with the TitoPay team";
    referenceBox.textContent = `Chat ${payload.chat.chat_number} · ${status}${Number(payload.chat.callback_requested) === 1 ? " · callback requested" : ""}`;
    replyForm.hidden = payload.chat.status === "closed";
    messagesBox.textContent = "";
    (payload.messages || []).forEach((message) => {
      const bubble = document.createElement("div");
      bubble.className = `support-chat-message is-${message.sender_type || "system"}`;
      const meta = document.createElement("small");
      meta.textContent = `${message.sender_name || "TitoPay"} · ${String(message.created_at || "").replace("T", " ").slice(0, 16)}`;
      const copy = document.createElement("p");
      copy.textContent = message.message || "";
      bubble.append(meta, copy);
      messagesBox.appendChild(bubble);
    });
    messagesBox.scrollTop = messagesBox.scrollHeight;
  }

  async function pollChat() {
    if (!currentChatId) return;
    try {
      const payload = await chatRequest({ action: "poll", chatId: currentChatId });
      renderMessages(payload);
      if (payload.chat?.status === "closed" && pollTimer) {
        window.clearInterval(pollTimer);
        pollTimer = null;
      }
    } catch {
      // The next customer action can retry; avoid noisy errors while browsing.
    }
  }

  function startPolling() {
    if (pollTimer) window.clearInterval(pollTimer);
    pollTimer = window.setInterval(pollChat, 12000);
  }

  launcher.addEventListener("click", () => {
    if (widget.classList.contains("is-open")) closeChat();
    else openChat();
  });
  closeButton.addEventListener("click", closeChat);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && widget.classList.contains("is-open")) closeChat();
  });

  botForm.querySelector("input")?.addEventListener("focus", () => window.setTimeout(scrollToEnd, 300));

  botForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const input = botForm.querySelector("[name='question']");
    const question = String(input?.value || "").trim();
    if (!question) return;
    input.value = "";
    ask(question);
  });

  widget.querySelector("[data-chat-cancel]").addEventListener("click", () => {
    addBubble("bot", "No problem. What else would you like to know?");
    hideHandoff();
  });

  widget.querySelector("[data-chat-new]").addEventListener("click", () => {
    if (pollTimer) window.clearInterval(pollTimer);
    pollTimer = null;
    currentChatId = "";
    localStorage.removeItem(chatStorageKey);
    showAssistant();
    greet();
  });

  startForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = serializeForm(startForm);
    if (String(data.website || "").trim()) {
      startForm.reset();
      return;
    }
    if (!data.name || !isEmail(data.email) || !String(data.message || "").trim()) {
      showToast("Please add your name, email address and message.");
      return;
    }
    const callbackRequested = Boolean(data.callback);
    if (callbackRequested && !String(data.phone || "").trim()) {
      showToast("Please add a contact number so the team can call you back.");
      return;
    }
    const earlier = askedQuestions.filter((q) => q !== "Talk to the TitoPay team" && q !== data.message).slice(-4);
    const message = earlier.length
      ? `${data.message}\n\nAsked the assistant first:\n- ${earlier.join("\n- ")}`
      : data.message;
    submitButton.disabled = true;
    try {
      const payload = await chatRequest({
        action: "start",
        website: data.website || "",
        name: data.name,
        email: data.email,
        phone: data.phone || "",
        topic: callbackRequested ? "Callback request" : lastTopic,
        message,
        callbackRequested
      });
      startForm.reset();
      renderMessages(payload);
      startPolling();
      showToast(`Sent to the TitoPay team. Your chat number is ${payload.chat.chat_number}.`);
    } catch (error) {
      showToast(error.message || "The TitoPay team chat is currently unavailable.");
    } finally {
      submitButton.disabled = false;
    }
  });

  replyForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const input = replyForm.querySelector("[name='message']");
    const message = String(input?.value || "").trim();
    if (!currentChatId || !message) return;
    try {
      const payload = await chatRequest({ action: "send", chatId: currentChatId, message });
      input.value = "";
      renderMessages(payload);
      startPolling();
    } catch (error) {
      showToast(error.message || "Message could not be sent.");
    }
  });

  greet();
  if (currentChatId) {
    pollChat();
    startPolling();
  }
}

/*
 * TitoPay feature flags.
 *
 * The published defaults describe TitoPay Events as it is today: the public
 * service page and the waitlist are open, and every piece of financial
 * functionality is off. Markup is authored in that "Coming Soon" state, so a
 * page that never reaches api/features.php keeps telling visitors the truth.
 * A flag can only ever relax a label, never invent one.
 */
const TITOPAY_FEATURE_DEFAULTS = {
  events_public_page: true,
  events_waitlist: true,
  event_wallets: false,
  event_payments: false,
  event_rfid: false,
  event_vendor_settlements: false
};

let titopayFeatures = { ...TITOPAY_FEATURE_DEFAULTS };

function featureEnabled(key) {
  return titopayFeatures[key] === true;
}

async function loadFeatureFlags() {
  try {
    const response = await fetch("api/features.php", { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error("Feature endpoint unavailable.");
    const payload = await response.json();
    if (payload && payload.features && typeof payload.features === "object") {
      Object.keys(TITOPAY_FEATURE_DEFAULTS).forEach((key) => {
        if (typeof payload.features[key] === "boolean") titopayFeatures[key] = payload.features[key];
      });
    }
  } catch {
    // Static previews and hosts without PHP keep the safe defaults above.
  }
  return titopayFeatures;
}

function applyFeatureFlags() {
  document.querySelectorAll("[data-feature]").forEach((node) => {
    const live = featureEnabled(node.dataset.feature);
    node.dataset.featureState = live ? "live" : "planned";
    const flag = node.querySelector(".events-flag");
    if (flag) flag.textContent = live ? "Live" : flag.dataset.plannedLabel || "Coming Soon";
  });

  document.querySelectorAll("[data-feature-gate]").forEach((node) => {
    const open = featureEnabled(node.dataset.featureGate);
    node.dataset.featureState = open ? "live" : "closed";
    if (open) return;
    node.querySelectorAll("input, select, textarea, button").forEach((field) => {
      field.disabled = true;
    });
  });

  document.querySelectorAll("[data-feature-notice]").forEach((node) => {
    node.hidden = featureEnabled(node.dataset.featureNotice);
  });
}

async function initFeatureFlags() {
  await loadFeatureFlags();

  const page = document.body.dataset.page || "";
  if (page === "events" && !featureEnabled("events_public_page")) {
    window.location.replace("/");
    return;
  }

  applyFeatureFlags();
}

initFeatureFlags();
initSupportChat();
initPrivacyPreferences();

/*
 * Scroll check. Open any page with ?scrollcheck in the address to show a small
 * report of what the browser does with the mouse wheel. Used to diagnose
 * "the page will not scroll" reports on browsers we cannot test directly.
 * It changes nothing and only appears when asked for.
 */
(function initScrollCheck() {
  if (!/[?&]scrollcheck\b/.test(window.location.search)) return;
  const box = document.createElement("pre");
  box.setAttribute("aria-live", "polite");
  box.style.cssText = "position:fixed;left:12px;top:12px;z-index:99999;max-width:min(560px,calc(100% - 24px));max-height:70vh;overflow:auto;margin:0;padding:12px 14px;border-radius:12px;background:rgba(1,10,63,.94);color:#fff;font:12px/1.5 ui-monospace,Menlo,monospace;white-space:pre-wrap;pointer-events:none;";
  document.body.appendChild(box);

  const describe = (el) => {
    if (!(el instanceof Element)) return String(el);
    const cls = typeof el.className === "string" && el.className.trim() ? "." + el.className.trim().split(/\s+/).join(".") : "";
    return el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + cls;
  };
  const scrollers = () => {
    const found = [];
    document.querySelectorAll("*").forEach((el) => {
      const cs = getComputedStyle(el);
      if (/(auto|scroll|hidden)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 1 && el !== box) {
        found.push(`${describe(el)} overflow-y:${cs.overflowY} ${el.clientHeight}/${el.scrollHeight}`);
      }
    });
    return found.slice(0, 6);
  };
  let last = "turn the mouse wheel over the page";
  const render = () => {
    const html = getComputedStyle(document.documentElement);
    const body = getComputedStyle(document.body);
    box.textContent = [
      "TitoPay scroll check",
      `browser: ${navigator.userAgent}`,
      `window: ${innerWidth}x${innerHeight}  zoom: ${devicePixelRatio}`,
      `page height: ${document.documentElement.scrollHeight}  scrolled: ${Math.round(scrollY)}`,
      `html: overflow ${html.overflowX}/${html.overflowY}  class "${document.documentElement.className}"`,
      `body: overflow ${body.overflowX}/${body.overflowY}  position ${body.position}  class "${document.body.className}"`,
      `inner scroll areas: ${scrollers().join(" | ") || "none"}`,
      `last wheel: ${last}`
    ].join("\n");
  };
  // Browsers may move the page before or after the wheel event reaches the
  // page, so compare with where the page was when the last report was made.
  let baseline = scrollY;
  let settle = null;
  window.addEventListener("wheel", (event) => {
    const target = describe(event.target);
    const deltaY = Math.round(event.deltaY);
    window.clearTimeout(settle);
    settle = window.setTimeout(() => {
      last = `over ${target}  deltaY ${deltaY}  blocked ${event.defaultPrevented}  page moved ${Math.round(scrollY - baseline)}px`;
      baseline = scrollY;
      render();
    }, 300);
  }, { passive: true });
  window.addEventListener("scroll", render, { passive: true });
  render();
})();

// Small, optional motion; content stays visible without JavaScript or motion support.
(function signatureMotion() {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || !('IntersectionObserver' in window)) return;
  const observer = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('signature-in-view');
        observer.unobserve(entry.target);
      }
    });
  }, {threshold:0.12});
  document.querySelectorAll('.editorial-heading, .personal-stage, .business-stage, .business-layout, .security-story .container, .section-head, .info-card, .signature-fees').forEach(item => observer.observe(item));
})();

// Restore normal page scrolling if an overlay no longer exists after navigation.
(function maintainScrollState() {
  function reconcile() {
    const root = document.documentElement;
    const body = document.body;
    if (!document.querySelector('[data-privacy-panel]')) root.classList.remove('privacy-locked');
    if (!document.querySelector('.support-chat.is-open')) {
      root.classList.remove('tito-open');
      body.classList.remove('tito-open');
      body.style.removeProperty('--tito-scroll-lock-top');
    }
    const menu = document.querySelector('.mobile-toggle');
    if (!menu || menu.getAttribute('aria-expanded') !== 'true') {
      body.classList.remove('menu-open');
      body.style.removeProperty('--menu-scroll-lock-top');
    }
  }
  window.addEventListener('pageshow', reconcile);
  window.addEventListener('focus', reconcile);
  window.addEventListener('resize', reconcile);
  reconcile();
})();
