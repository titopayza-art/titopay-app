const body = document.body;
const mobileToggle = document.querySelector(".mobile-toggle");
const mobilePanel = document.querySelector(".mobile-panel");
const toast = document.getElementById("toast");
let lockedScrollY = 0;

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
    if (event.key === "Escape") setOpen(false);
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
  if (!response.ok) throw new Error("Application endpoint unavailable.");
  return response.json();
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
    let reason = "This request could not be accepted.";
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
  return response.json();
}

if (mobileToggle && mobilePanel) {
  const shouldLockMobileScroll = () => window.matchMedia("(max-width: 680px)").matches;

  function openMobileMenu() {
    if (shouldLockMobileScroll()) {
      lockedScrollY = window.scrollY || document.documentElement.scrollTop || 0;
      body.style.setProperty("--menu-scroll-lock-top", `-${lockedScrollY}px`);
    }
    body.classList.add("menu-open");
    mobileToggle.setAttribute("aria-expanded", "true");
    mobileToggle.setAttribute("aria-label", "Close menu");
    mobileToggle.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>';
  }

  function closeMobileMenu() {
    const restoreScroll = shouldLockMobileScroll() && body.classList.contains("menu-open");
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
      serverSubmission = await submitPublicForm({ formType: "waitlist", ...record });
    } catch (error) {
      if (error.serverRejected) {
        showToast(error.message);
        return;
      }
      // Static/local previews keep a browser copy. Hosted PHP captures shared records for TitoPay.
    }

    const saved = JSON.parse(localStorage.getItem("titopayWaitlist") || "[]");
    saved.push(record);
    localStorage.setItem("titopayWaitlist", JSON.stringify(saved));

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
      serverSubmission = await submitPublicForm({ formType: "contact", ...record });
    } catch (error) {
      if (error.serverRejected) {
        showToast(error.message);
        return;
      }
      // Static/local previews keep a browser copy. Hosted PHP captures shared records for TitoPay.
    }

    const saved = readStoredList("titopayContactRequests");
    saved.push(record);
    writeStoredList("titopayContactRequests", saved);

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

    const saved = readStoredList("titopayCareerApplications");
    saved.push(record);
    writeStoredList("titopayCareerApplications", saved);

    const candidateNotes = [
      data.message && `Motivation: ${data.message}`,
      data.phone && `Phone: ${data.phone}`,
      data.qualification && `Qualification: ${data.qualification}`,
      data.portfolio && `LinkedIn / portfolio: ${data.portfolio}`,
      data.workAuth && `Work eligibility: ${data.workAuth}`,
      attachments.length && `Attachments:\n${attachmentSummary(attachments)}`,
      `Submitted via TitoPay marketing website on ${submittedAt.slice(0, 10)}.`
    ].filter(Boolean).join("\n");

    const candidates = readStoredList("titopay_hr_candidates");
    const existingIndex = candidates.findIndex((candidate) =>
      String(candidate.email || "").toLowerCase() === String(data.email || "").toLowerCase() &&
      String(candidate.jobTitle || "") === String(data.role || "")
    );
    const candidateRecord = {
      id: existingIndex >= 0 ? candidates[existingIndex].id : makeRecordId("candidate"),
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
      createdAt: existingIndex >= 0 ? candidates[existingIndex].createdAt || submittedAt : submittedAt,
      updatedAt: submittedAt
    };

    const localCandidateRecord = stripAttachmentData(candidateRecord);
    if (existingIndex >= 0) candidates[existingIndex] = localCandidateRecord;
    else candidates.push(localCandidateRecord);
    writeStoredList("titopay_hr_candidates", candidates);

    const audit = readStoredList("titopay_hr_audit");
    audit.push({
      id: makeRecordId("audit"),
      user: "Marketing website",
      action: "candidate_application",
      entity: "candidates",
      detail: `${data.name} applied for ${data.role}`,
      createdAt: submittedAt
    });
    writeStoredList("titopay_hr_audit", audit);

    let serverApplication = null;
    try {
      serverApplication = await sendApplicationToServer(candidateRecord);
    } catch {
      // Static/local previews use browser storage. Hosted PHP captures shared submissions for HR.
    }

    applicationForm.reset();
    const applicationNumber = serverApplication?.candidate?.application_number || serverApplication?.application?.application_number;
    showToast(applicationNumber ? `Application received. Your TitoPay application number is ${applicationNumber}.` : "Application submitted. TitoPay HR can review it in the HR portal candidate pipeline.");
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

  function closePanel() {
    document.querySelector("[data-privacy-panel]")?.remove();
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
        <button class="privacy-close" type="button" aria-label="Close privacy preferences">×</button>
        <span class="label">Privacy Controls</span>
        <h2 id="privacy-panel-title">TitoPay privacy preferences</h2>
        <p>Choose how TitoPay may use optional cookies and browser storage. Essential storage keeps forms, security checks, and preference choices working. Optional categories are off unless you allow them.</p>
        <div class="privacy-options">
          <label class="privacy-option is-required">
            <span><strong>Essential</strong><small>Required for site security, forms, and remembering this choice.</small></span>
            <input type="checkbox" checked disabled>
          </label>
          <label class="privacy-option">
            <span><strong>Analytics</strong><small>Helps TitoPay understand site performance and improve user journeys when analytics is enabled.</small></span>
            <input name="analytics" type="checkbox"${saved.analytics ? " checked" : ""}>
          </label>
          <label class="privacy-option">
            <span><strong>Marketing updates</strong><small>Allows TitoPay to remember communication preferences for product, waitlist, and launch updates.</small></span>
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
      showToast("Your TitoPay privacy preferences have been saved.");
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
    banner.setAttribute("aria-label", "TitoPay privacy preferences");
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
      showToast("All TitoPay privacy preferences have been accepted.");
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
    button.textContent = "Privacy settings";
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
  const faqItems = [
    {
      question: "When is TitoPay launching?",
      answer: "TitoPay is preparing early access for South African personal and business users. Join the waitlist and support can keep you updated on launch readiness."
    },
    {
      question: "How do I join the waitlist?",
      answer: "Use the Join Waitlist page, choose personal or business interest, and submit your details. You will receive a TitoPay ticket number for reference.",
      link: "waitlist",
      linkText: "Open waitlist"
    },
    {
      question: "When is TitoPay Events launching?",
      answer: "TitoPay Events is coming soon. Live event payments, event wallets, and vendor settlements are not active yet. Join the TitoPay Events waitlist to be told when it opens.",
      link: "events",
      linkText: "Open TitoPay Events"
    },
    {
      question: "Bring TitoPay to my event",
      answer: "Organisers can register an upcoming event through the TitoPay Events page. TitoPay will make contact to plan onboarding once the service opens.",
      link: "events",
      linkText: "Register an event"
    },
    {
      question: "Is TitoPay a bank?",
      answer: "TitoPay is a fintech brand building secure payment and wallet experiences. Banking, payment, compliance, and partner disclosures will be communicated as services become available."
    },
    {
      question: "Business onboarding",
      answer: "Businesses can register interest for merchant payment tools, QR payments, settlement support, and dashboard access through the waitlist or contact page.",
      link: "business",
      linkText: "Business page"
    },
    {
      question: "Security concern",
      answer: "Never share passwords, PINs, OTPs, or recovery details. For urgent security concerns, talk to an agent here or submit the Security Center form so TitoPay can issue a support ticket."
    }
  ];

  let currentChatId = localStorage.getItem(chatStorageKey) || "";
  let pollTimer = null;
  let selectedMode = "agent";

  const widget = document.createElement("section");
  widget.className = "support-chat";
  widget.dataset.supportChat = "true";
  widget.innerHTML = `
    <button class="support-chat-launcher" type="button" aria-expanded="false" aria-controls="support-chat-panel">
      <span>Support</span>
    </button>
    <div class="support-chat-panel" id="support-chat-panel" aria-hidden="true">
      <div class="support-chat-header">
        <div>
          <span class="label">TitoPay Support</span>
          <h2>How can we help?</h2>
        </div>
        <button class="support-chat-close" type="button" aria-label="Close support chat">×</button>
      </div>
      <div class="support-chat-body">
        <div class="support-chat-faqs" data-chat-faqs></div>
        <div class="support-chat-answer" data-chat-answer hidden></div>
        <div class="support-chat-actions">
          <button class="btn btn-primary" type="button" data-chat-mode="agent">Talk to an agent</button>
          <button class="btn btn-secondary" type="button" data-chat-mode="callback">Request callback</button>
        </div>
        <form class="support-chat-form" data-chat-start-form>
          <input name="website" type="text" tabindex="-1" autocomplete="off" aria-hidden="true">
          <label><span>Name</span><input name="name" autocomplete="name" required></label>
          <label><span>Email</span><input name="email" type="email" autocomplete="email" required></label>
          <label><span>Contact number</span><input name="phone" autocomplete="tel" placeholder="+27"></label>
          <label><span>Topic</span><select name="topic"><option>General support</option><option>Waitlist support</option><option>TitoPay Events enquiry</option><option>Business onboarding</option><option>Security concern</option><option>Callback request</option></select></label>
          <label class="full"><span>Message</span><textarea name="message" placeholder="Type your question or callback request." required></textarea></label>
          <button class="btn btn-primary full" type="submit" data-chat-submit>Start support chat</button>
        </form>
        <div class="support-chat-live" data-chat-live hidden>
          <div class="support-chat-reference" data-chat-reference></div>
          <div class="support-chat-messages" data-chat-messages aria-live="polite"></div>
          <form class="support-chat-reply" data-chat-reply-form>
            <input name="message" placeholder="Type a reply..." autocomplete="off" required>
            <button class="btn btn-primary" type="submit">Send</button>
          </form>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(widget);

  const launcher = widget.querySelector(".support-chat-launcher");
  const panel = widget.querySelector(".support-chat-panel");
  const closeButton = widget.querySelector(".support-chat-close");
  const faqWrap = widget.querySelector("[data-chat-faqs]");
  const answerBox = widget.querySelector("[data-chat-answer]");
  const startForm = widget.querySelector("[data-chat-start-form]");
  const liveWrap = widget.querySelector("[data-chat-live]");
  const referenceBox = widget.querySelector("[data-chat-reference]");
  const messagesBox = widget.querySelector("[data-chat-messages]");
  const replyForm = widget.querySelector("[data-chat-reply-form]");
  const submitButton = widget.querySelector("[data-chat-submit]");

  function openChat() {
    widget.classList.add("is-open");
    launcher.setAttribute("aria-expanded", "true");
    panel.setAttribute("aria-hidden", "false");
    if (currentChatId) pollChat();
  }

  function closeChat() {
    widget.classList.remove("is-open");
    launcher.setAttribute("aria-expanded", "false");
    panel.setAttribute("aria-hidden", "true");
  }

  function setMode(mode) {
    selectedMode = mode === "callback" ? "callback" : "agent";
    widget.querySelectorAll("[data-chat-mode]").forEach((button) => {
      button.classList.toggle("is-active", button.dataset.chatMode === selectedMode);
    });
    if (submitButton) submitButton.textContent = selectedMode === "callback" ? "Request callback" : "Start support chat";
    const topic = startForm?.querySelector("[name='topic']");
    if (topic && selectedMode === "callback") topic.value = "Callback request";
  }

  function renderFaqs() {
    faqItems.forEach((item) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "support-chat-faq";
      button.textContent = item.question;
      button.addEventListener("click", () => {
        answerBox.hidden = false;
        answerBox.textContent = "";
        const strong = document.createElement("strong");
        strong.textContent = item.question;
        const paragraph = document.createElement("p");
        paragraph.textContent = item.answer;
        answerBox.append(strong, paragraph);
        if (item.link) {
          const link = document.createElement("a");
          link.className = "text-link";
          link.href = item.link;
          link.textContent = item.linkText || "Open page";
          answerBox.appendChild(link);
        }
      });
      faqWrap.appendChild(button);
    });
  }

  async function chatRequest(payload) {
    const response = await fetch("api/chat.php", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok) throw new Error(result.error || "Support chat is currently unavailable.");
    return result;
  }

  function renderMessages(payload) {
    if (!payload?.chat) return;
    currentChatId = payload.chat.id || currentChatId;
    localStorage.setItem(chatStorageKey, currentChatId);
    startForm.hidden = true;
    liveWrap.hidden = false;
    referenceBox.textContent = `${payload.chat.chat_number} · ${payload.chat.status}${Number(payload.chat.callback_requested) === 1 ? " · callback requested" : ""}`;
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
  widget.querySelectorAll("[data-chat-mode]").forEach((button) => {
    button.addEventListener("click", () => setMode(button.dataset.chatMode || "agent"));
  });

  startForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = serializeForm(startForm);
    if (String(data.website || "").trim()) {
      startForm.reset();
      return;
    }
    if (!data.name || !isEmail(data.email) || String(data.message || "").trim().length < 3) {
      showToast("Please add your name, email address, and message.");
      return;
    }
    if (selectedMode === "callback" && !String(data.phone || "").trim()) {
      showToast("Please add your contact number for a callback.");
      return;
    }
    submitButton.disabled = true;
    try {
      const payload = await chatRequest({
        action: "start",
        name: data.name,
        email: data.email,
        phone: data.phone || "",
        topic: data.topic || (selectedMode === "callback" ? "Callback request" : "Live support"),
        message: data.message,
        callbackRequested: selectedMode === "callback"
      });
      renderMessages(payload);
      startPolling();
      showToast(`Support chat opened: ${payload.chat.chat_number}`);
    } catch (error) {
      showToast(error.message || "Support chat is currently unavailable.");
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

  renderFaqs();
  setMode("agent");
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
