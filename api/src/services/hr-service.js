const crypto = require("crypto");
const { pool } = require("../db/pool");
const { AppError } = require("../lib/errors");
const { signAccessToken, signRefreshToken, verifyRefreshToken } = require("../lib/jwt");
const { hashPassword, verifyPassword } = require("../lib/passwords");
const { tokenHash, hasHrPermission, hrGrantScope } = require("../middleware/hr-auth");

const refreshTokenDays = Number(process.env.HR_REFRESH_TOKEN_DAYS || 7);

const resources = {
  employees: {
    module: "employees",
    table: "hr_employees",
    searchable: ["employee_number", "first_name", "last_name", "email", "job_title", "department", "status"],
    columns: {
      employeeNumber: "employee_number",
      firstName: "first_name",
      lastName: "last_name",
      email: "email",
      phone: "phone",
      jobTitle: "job_title",
      department: "department",
      employmentType: "employment_type",
      startDate: "start_date",
      salary: "salary",
      hourlyRate: "hourly_rate",
      contractHoursPerWeek: "contract_hours_per_week",
      workStartTime: "work_start_time",
      workEndTime: "work_end_time",
      lunchMinutes: "lunch_minutes",
      taxNumber: "tax_number",
      bankName: "bank_name",
      bankAccount: "bank_account",
      workLocation: "work_location",
      status: "status",
      emergencyContact: "emergency_contact",
      skills: "skills",
      medicalInfo: "medical_info",
      managerId: "manager_id"
    },
    defaultOrder: "created_at DESC"
  },
  onboarding: {
    module: "onboarding",
    table: "hr_onboarding_tasks",
    searchable: ["employee", "title", "category", "status"],
    columns: { employee: "employee", title: "title", category: "category", dueDate: "due_date", status: "status", notes: "notes" },
    defaultOrder: "due_date ASC NULLS LAST, created_at DESC"
  },
  leave: {
    module: "leave",
    table: "hr_leave_requests",
    searchable: ["employee", "type", "reason", "status"],
    columns: { employee: "employee", type: "type", startDate: "start_date", endDate: "end_date", days: "days", reason: "reason", status: "status", managerComment: "manager_comment", hrComment: "hr_comment" },
    defaultOrder: "created_at DESC"
  },
  attendance: {
    module: "attendance",
    table: "hr_attendance_records",
    searchable: ["employee", "work_mode", "status"],
    columns: { employee: "employee", workDate: "work_date", clockIn: "clock_in", clockOut: "clock_out", lunchStart: "lunch_start", lunchEnd: "lunch_end", breakMinutes: "break_minutes", regularMinutes: "regular_minutes", workMode: "work_mode", status: "status", minutesLate: "minutes_late", overtimeMinutes: "overtime_minutes", employeeSignature: "employee_signature", apologyReason: "apology_reason", attendanceSource: "attendance_source" },
    defaultOrder: "work_date DESC, created_at DESC"
  },
  payroll: {
    module: "payroll",
    table: "hr_payroll_records",
    searchable: ["employee", "period", "status"],
    columns: { employee: "employee", period: "period", baseSalary: "base_salary", allowances: "allowances", deductions: "deductions", bonuses: "bonuses", tax: "tax", uif: "uif", pension: "pension", medicalAid: "medical_aid", reimbursements: "reimbursements", netPay: "net_pay", status: "status" },
    defaultOrder: "period DESC, created_at DESC"
  },
  performance: {
    module: "performance",
    table: "hr_performance_reviews",
    searchable: ["employee", "period", "kpis", "status"],
    columns: { employee: "employee", period: "period", kpis: "kpis", objectives: "objectives", selfReview: "self_review", managerFeedback: "manager_feedback", peerReview: "peer_review", score: "score", improvementPlan: "improvement_plan", promotionRecommendation: "promotion_recommendation", status: "status" },
    defaultOrder: "created_at DESC"
  },
  disciplinary: {
    module: "disciplinary",
    table: "hr_disciplinary_cases",
    searchable: ["case_number", "employee", "type", "status"],
    columns: { caseNumber: "case_number", employee: "employee", type: "type", incidentDate: "incident_date", description: "description", investigationNotes: "investigation_notes", hearingDate: "hearing_date", outcome: "outcome", evidenceUrl: "evidence_url", status: "status" },
    defaultOrder: "created_at DESC"
  },
  documents: {
    module: "documents",
    table: "hr_company_documents",
    searchable: ["title", "category", "description", "status"],
    columns: { title: "title", category: "category", department: "department", rolePermission: "role_permission", version: "version", description: "description", fileUrl: "file_url", requiresSignature: "requires_signature", requiredReading: "required_reading", expiresAt: "expires_at", status: "status" },
    defaultOrder: "updated_at DESC"
  },
  jobs: {
    module: "recruitment",
    table: "hr_recruitment_jobs",
    searchable: ["title", "department", "location", "status"],
    columns: { title: "title", department: "department", location: "location", closingDate: "closing_date", description: "description", status: "status", applicants: "applicants" },
    defaultOrder: "created_at DESC"
  },
  candidates: {
    module: "recruitment",
    table: "hr_recruitment_candidates",
    searchable: ["name", "email", "job_title", "stage", "status", "source", "phone"],
    columns: { name: "name", email: "email", jobTitle: "job_title", source: "source", phone: "phone", qualification: "qualification", portfolio: "portfolio", websiteApplicationId: "website_application_id", stage: "stage", notes: "notes", resumeUrl: "resume_url", rating: "rating", offerStatus: "offer_status", status: "status" },
    defaultOrder: "created_at DESC"
  },
  tickets: {
    module: "tickets",
    table: "hr_tickets",
    searchable: ["requester", "type", "subject", "priority", "status"],
    columns: { requester: "requester", type: "type", subject: "subject", description: "description", priority: "priority", escalationLevel: "escalation_level", status: "status" },
    defaultOrder: "created_at DESC"
  },
  help: {
    module: "tickets",
    table: "hr_tickets",
    searchable: ["requester", "type", "subject", "priority", "status"],
    columns: { requester: "requester", type: "type", subject: "subject", description: "description", priority: "priority", escalationLevel: "escalation_level", status: "status" },
    defaultOrder: "created_at DESC"
  },
  projects: {
    module: "projects",
    table: "hr_projects",
    searchable: ["project_name", "owner", "department", "latest_update", "status"],
    columns: { projectName: "project_name", name: "project_name", title: "project_name", owner: "owner", ownerId: "owner_id", department: "department", startDate: "start_date", dueDate: "due_date", progress: "progress", currentMilestone: "current_milestone", latestUpdate: "latest_update", blockers: "blockers", priority: "priority", status: "status" },
    defaultOrder: "due_date ASC NULLS LAST, created_at DESC"
  },
  meetings: {
    module: "meetings",
    table: "hr_meetings",
    searchable: ["title", "chair", "agenda", "department", "status"],
    columns: { title: "title", meetingDate: "meeting_date", meetingAt: "meeting_date", meetingTime: "meeting_time", chair: "chair", chairId: "chair_id", department: "department", agenda: "agenda", attendees: "attendees", attendanceRegister: "attendees", apologies: "apologies", previousMinutes: "previous_minutes", outcomes: "outcomes", status: "status" },
    defaultOrder: "meeting_date DESC NULLS LAST, created_at DESC"
  },
  uploads: {
    module: "documents",
    table: "hr_employee_documents",
    searchable: ["title", "category", "status", "mime_type"],
    columns: { title: "title", category: "category", fileUrl: "file_url", mimeType: "mime_type", requiresSignature: "requires_signature", status: "status" },
    defaultOrder: "created_at DESC"
  },
  audit: {
    module: "audit",
    table: "hr_audit_logs",
    searchable: ["user_email", "action", "entity", "detail"],
    columns: { user: "user_email", action: "action", entity: "entity", detail: "detail" },
    defaultOrder: "created_at DESC",
    readOnly: true
  },
  learning: {
    module: "learning",
    table: "hr_learning_courses",
    searchable: ["title", "category", "description", "department", "role_permission", "status"],
    columns: {
      title: "title",
      category: "category",
      format: "format",
      description: "description",
      overview: "overview",
      level: "level",
      department: "department",
      rolePermission: "role_permission",
      tags: "tags",
      durationMinutes: "duration_minutes",
      dueDays: "due_days",
      featured: "featured",
      handbookContent: "handbook_content",
      passMark: "pass_mark",
      courseUrl: "course_url",
      videoUrl: "video_url",
      pdfUrl: "pdf_url",
      presentationUrl: "presentation_url",
      imageUrl: "image_url",
      certificateEnabled: "certificate_enabled",
      mandatory: "mandatory",
      assessmentRequired: "assessment_required",
      status: "status"
    },
    defaultOrder: "featured DESC, mandatory DESC, created_at DESC"
  },
  "learning-modules": {
    module: "learning",
    table: "hr_learning_modules",
    searchable: ["title", "summary", "status"],
    columns: { courseId: "course_id", title: "title", summary: "summary", sortOrder: "sort_order", status: "status" },
    defaultOrder: "sort_order ASC, created_at ASC"
  },
  "learning-lessons": {
    module: "learning",
    table: "hr_learning_lessons",
    searchable: ["title", "lesson_type", "content", "status"],
    columns: { moduleId: "module_id", title: "title", lessonType: "lesson_type", content: "content", resourceUrl: "resource_url", durationMinutes: "duration_minutes", sortOrder: "sort_order", status: "status" },
    defaultOrder: "sort_order ASC, created_at ASC"
  },
  "learning-assignments": {
    module: "learning",
    table: "hr_learning_assignments",
    searchable: ["department", "role_permission", "status"],
    columns: { courseId: "course_id", employeeId: "employee_id", department: "department", rolePermission: "role_permission", mandatory: "mandatory", dueDate: "due_date", assignedBy: "assigned_by", status: "status" },
    defaultOrder: "created_at DESC"
  },
  "learning-progress": {
    module: "learning",
    table: "hr_learning_enrolments",
    searchable: ["status"],
    columns: { courseId: "course_id", employeeId: "employee_id", userId: "user_id", status: "status", progressPercent: "progress_percent", completedAt: "completed_at" },
    defaultOrder: "last_seen_at DESC"
  },
  "learning-certificates": {
    module: "learning",
    table: "hr_learning_certificates",
    searchable: ["certificate_number", "status"],
    columns: { courseId: "course_id", employeeId: "employee_id", userId: "user_id", certificateNumber: "certificate_number", score: "score", fileUrl: "file_url", status: "status" },
    defaultOrder: "issued_at DESC"
  },
  assets: {
    module: "assets",
    table: "hr_assets",
    searchable: ["asset_tag", "type", "assigned_to", "status"],
    columns: { assetTag: "asset_tag", type: "type", serialNumber: "serial_number", assignedTo: "assigned_to", assignedAt: "assigned_at", warrantyExpiry: "warranty_expiry", maintenanceHistory: "maintenance_history", status: "status" },
    defaultOrder: "created_at DESC"
  },
  expenses: {
    module: "expenses",
    table: "hr_expense_claims",
    searchable: ["employee", "type", "status"],
    columns: { employee: "employee", type: "type", amount: "amount", currency: "currency", receiptUrl: "receipt_url", description: "description", managerStatus: "manager_status", financeStatus: "finance_status", paymentStatus: "payment_status", status: "status" },
    defaultOrder: "created_at DESC"
  },
  announcements: {
    module: "announcements",
    table: "hr_announcements",
    searchable: ["title", "audience", "status"],
    columns: { title: "title", body: "body", audience: "audience", priority: "priority", publishAt: "publish_at", status: "status" },
    defaultOrder: "created_at DESC"
  },
  departments: {
    module: "organisation",
    table: "hr_departments",
    searchable: ["name", "manager", "cost_centre"],
    columns: { name: "name", manager: "manager", costCentre: "cost_centre", status: "status" },
    defaultOrder: "name ASC"
  }
};

function toCamel(value) {
  return value.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

function cleanPayload(payload, config) {
  const clean = {};
  Object.entries(config.columns).forEach(([apiKey, dbKey]) => {
    if (payload[apiKey] !== undefined) clean[dbKey] = payload[apiKey];
  });
  return clean;
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

function asTrimmedText(value) {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text ? text : undefined;
}

function asLowerEmail(value) {
  const text = asTrimmedText(value);
  return text ? text.toLowerCase() : undefined;
}

function asNumber(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const cleaned = String(value).replace(/[R,\s]/g, "");
  const number = Number(cleaned);
  return Number.isFinite(number) ? number : undefined;
}

function asInteger(value) {
  const number = asNumber(value);
  return number === undefined ? undefined : Math.round(number);
}

function asBoolean(value) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "boolean") return value;
  const text = String(value).trim().toLowerCase();
  if (["true", "yes", "1", "on", "required"].includes(text)) return true;
  if (["false", "no", "0", "off", "not required"].includes(text)) return false;
  return undefined;
}

function normaliseDate(value) {
  const text = asTrimmedText(value);
  if (!text) return undefined;
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  const slashMatch = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slashMatch) {
    const [, day, month, year] = slashMatch;
    return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  }
  return text;
}

function normaliseTime(value) {
  const text = asTrimmedText(value);
  if (!text) return undefined;
  const match = text.match(/^(\d{1,2}):(\d{2})/);
  if (!match) return text;
  return `${match[1].padStart(2, "0")}:${match[2]}`;
}

function normaliseStatus(value, allowed, fallback) {
  const text = asTrimmedText(value);
  if (!text) return fallback;
  const normalized = text.toLowerCase().replace(/[\s-]+/g, "_");
  const aliases = {
    active: "active",
    enabled: "active",
    current: "active",
    suspended: "suspended",
    blocked: "suspended",
    disabled: "disabled",
    resigned: "resigned",
    terminated: "terminated",
    pending: "pending",
    in_progress: "in_progress",
    progress: "in_progress",
    complete: "complete",
    completed: "complete",
    overdue: "overdue",
    present: "present",
    absent: "absent",
    apology: "apology",
    lunch: "lunch",
    open: "open",
    resolved: "resolved",
    draft: "draft",
    submitted: "submitted",
    approved: "approved",
    rejected: "rejected"
  };
  const mapped = aliases[normalized] || normalized;
  return allowed.includes(mapped) ? mapped : fallback;
}

function withAliases(payload = {}, aliases = {}) {
  const next = { ...payload };
  Object.entries(aliases).forEach(([target, candidates]) => {
    const value = firstDefined(next[target], ...candidates.map((key) => next[key]));
    if (value !== undefined) next[target] = value;
  });
  return next;
}

function normaliseHrPayload(resourceName, payload = {}, auth = {}) {
  let next = { ...payload };

  if (resourceName === "employees") {
    next = withAliases(next, {
      employeeNumber: ["employeeNo", "employee_number", "staffNumber", "staffNo"],
      firstName: ["first_name", "givenName"],
      lastName: ["last_name", "surname", "familyName"],
      email: ["workEmail", "work_email", "staffEmail", "emailAddress"],
      phone: ["cellphone", "mobile", "mobileNumber", "phoneNumber", "contactNumber"],
      jobTitle: ["job_title", "position", "role", "title"],
      employmentType: ["employment_type", "type"],
      startDate: ["start_date", "employmentStartDate", "joiningDate"],
      salary: ["monthlySalary", "monthly_salary", "baseSalary", "base_salary"],
      hourlyRate: ["hourly_rate", "ratePerHour", "rate_per_hour"],
      contractHoursPerWeek: ["contract_hours_per_week", "weeklyHours", "hoursPerWeek"],
      workStartTime: ["work_start_time", "startTime", "shiftStart"],
      workEndTime: ["work_end_time", "endTime", "shiftEnd"],
      lunchMinutes: ["lunch_minutes", "lunchBreak", "lunchBreakMinutes"],
      workLocation: ["work_location", "location"],
      taxNumber: ["tax_number"],
      bankName: ["bank_name"],
      bankAccount: ["bank_account"],
      emergencyContact: ["emergency_contact"],
      medicalInfo: ["medical_info"],
      managerId: ["manager_id"]
    });
    next.firstName = asTrimmedText(next.firstName);
    next.lastName = asTrimmedText(next.lastName);
    next.email = asLowerEmail(next.email);
    next.phone = asTrimmedText(next.phone);
    next.jobTitle = asTrimmedText(next.jobTitle);
    next.department = asTrimmedText(next.department);
    next.employmentType = asTrimmedText(next.employmentType) || "Permanent";
    next.startDate = normaliseDate(next.startDate);
    const salary = asNumber(next.salary);
    if (next.salary !== undefined && (!Number.isFinite(salary) || salary < 0)) throw new AppError(400, "Salary must be a non-negative amount");
    next.salary = salary;
    const hourlyRate = asNumber(next.hourlyRate);
    if (next.hourlyRate !== undefined && (!Number.isFinite(hourlyRate) || hourlyRate < 0)) throw new AppError(400, "Hourly rate must be a non-negative amount");
    next.hourlyRate = hourlyRate;
    next.contractHoursPerWeek = asNumber(next.contractHoursPerWeek);
    next.workStartTime = normaliseTime(next.workStartTime);
    next.workEndTime = normaliseTime(next.workEndTime);
    next.lunchMinutes = asInteger(next.lunchMinutes);
    next.status = normaliseStatus(next.status, ["active", "suspended", "resigned", "terminated"], "active");
  } else if (resourceName === "onboarding") {
    next = withAliases(next, {
      employee: ["employeeName", "fullName", "name", "staffName"],
      title: ["task", "taskTitle", "name"],
      dueDate: ["due_date", "deadline"],
      status: ["state"]
    });
    next.employee = asTrimmedText(next.employee) || auth.name || auth.email || "Staff member";
    next.title = asTrimmedText(next.title) || "Self onboarding";
    next.category = asTrimmedText(next.category) || "Self onboarding";
    next.dueDate = normaliseDate(next.dueDate);
    next.status = normaliseStatus(next.status, ["pending", "in_progress", "complete", "overdue"], "in_progress");
  } else if (resourceName === "attendance") {
    next = withAliases(next, {
      employee: ["employeeName", "fullName", "name", "staffName"],
      workDate: ["work_date", "date"],
      clockIn: ["clock_in"],
      clockOut: ["clock_out"],
      lunchStart: ["lunch_start"],
      lunchEnd: ["lunch_end"],
      workMode: ["work_mode", "mode", "location"],
      employeeSignature: ["employee_signature", "signature", "fullName"],
      apologyReason: ["apology_reason", "reason"],
      attendanceSource: ["attendance_source", "source"]
    });
    next.employee = asTrimmedText(next.employee) || auth.name || auth.email || "Staff member";
    next.workDate = normaliseDate(next.workDate);
    next.workMode = asTrimmedText(next.workMode) || "Office";
    next.status = normaliseStatus(next.status, ["present", "absent", "apology", "lunch", "complete"], "present");
    next.breakMinutes = asInteger(next.breakMinutes);
    next.regularMinutes = asInteger(next.regularMinutes);
    next.minutesLate = asInteger(next.minutesLate);
    next.overtimeMinutes = asInteger(next.overtimeMinutes);
    next.attendanceSource = asTrimmedText(next.attendanceSource) || "hr-portal";
  } else if (resourceName === "payroll") {
    next = withAliases(next, {
      baseSalary: ["base_salary", "grossSalary", "gross_salary"],
      medicalAid: ["medical_aid"],
      netPay: ["net_pay"]
    });
    const moneyFields = ["baseSalary", "allowances", "deductions", "bonuses", "tax", "uif", "pension", "medicalAid", "reimbursements"];
    for (const field of moneyFields) {
      const value = asNumber(next[field] ?? 0);
      if (!Number.isFinite(value) || value < 0) throw new AppError(400, `${field} must be a non-negative amount`);
      next[field] = Math.round((value + Number.EPSILON) * 100) / 100;
    }
    const grossCents = ["baseSalary", "allowances", "bonuses", "reimbursements"]
      .reduce((sum, field) => sum + Math.round(next[field] * 100), 0);
    const deductionCents = ["deductions", "tax", "uif", "pension", "medicalAid"]
      .reduce((sum, field) => sum + Math.round(next[field] * 100), 0);
    const netCents = grossCents - deductionCents;
    if (netCents < 0) throw new AppError(400, "Payroll deductions cannot exceed gross earnings");
    next.netPay = (netCents / 100).toFixed(2);
    next.employee = asTrimmedText(next.employee);
    next.period = asTrimmedText(next.period);
    if (!next.employee) throw new AppError(400, "Employee is required");
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(next.period || "")) throw new AppError(400, "Payroll period must use YYYY-MM");
    next.status = normaliseStatus(next.status, ["draft", "review", "processed"], "draft");
  } else if (resourceName === "projects") {
    next = withAliases(next, {
      projectName: ["name", "title", "project_name"],
      owner: ["projectOwner", "ownerName"],
      ownerId: ["owner_id"],
      dueDate: ["due_date", "deadline"],
      progress: ["progressPercent", "progress_percent"]
    });
    next.projectName = asTrimmedText(next.projectName);
    next.owner = asTrimmedText(next.owner);
    next.department = asTrimmedText(next.department);
    next.startDate = normaliseDate(next.startDate);
    next.dueDate = normaliseDate(next.dueDate);
    const progress = Number(next.progress ?? 0);
    if (!Number.isFinite(progress) || progress < 0 || progress > 100) {
      throw new AppError(400, "The progress value must be between 0 and 100");
    }
    next.progress = Math.round(progress * 100) / 100;
    next.priority = asTrimmedText(next.priority) || "normal";
    next.status = asTrimmedText(next.status)?.toLowerCase().replace(/[\s-]+/g, "_") || "active";
    if (!["planning", "active", "at_risk", "completed", "paused", "archived"].includes(next.status)) {
      throw new AppError(400, "Project status is invalid");
    }
    if (!next.projectName) throw new AppError(400, "Project name is required");
  } else if (resourceName === "meetings") {
    next = withAliases(next, {
      meetingDate: ["meetingAt", "meeting_at", "date", "publishAt"],
      chair: ["chairperson", "chairName"],
      chairId: ["chair_id"],
      attendanceRegister: ["attendance_register", "register", "attendanceUrl"],
      previousMinutes: ["previous_minutes", "minutes", "minutesUrl"]
    });
    next.title = asTrimmedText(next.title);
    next.meetingDate = normaliseDate(next.meetingDate);
    next.chair = asTrimmedText(next.chair);
    next.department = asTrimmedText(next.department);
    next.meetingTime = normaliseTime(next.meetingTime);
    next.agenda = asTrimmedText(next.agenda);
    next.attendees = asTrimmedText(next.attendees ?? next.attendanceRegister);
    delete next.attendanceRegister;
    next.apologies = asTrimmedText(next.apologies);
    next.previousMinutes = asTrimmedText(next.previousMinutes);
    next.outcomes = asTrimmedText(next.outcomes);
    next.status = asTrimmedText(next.status)?.toLowerCase().replace(/[\s-]+/g, "_") || "scheduled";
    if (!["draft", "scheduled", "completed", "cancelled"].includes(next.status)) {
      throw new AppError(400, "Meeting status is invalid");
    }
    if (!next.title) throw new AppError(400, "Meeting title is required");
  } else if (resourceName === "documents" || resourceName === "uploads") {
    next = withAliases(next, {
      title: ["name", "fileName", "documentName"],
      category: ["type", "documentType"],
      fileUrl: ["file_url", "url", "storageUrl", "href"],
      mimeType: ["mime_type", "contentType"],
      rolePermission: ["role_permission", "audienceRole"],
      requiresSignature: ["requires_signature", "signatureRequired"],
      requiredReading: ["required_reading", "readingRequired"],
      expiresAt: ["expires_at", "expiryDate"]
    });
    next.title = asTrimmedText(next.title) || "HR document";
    next.category = asTrimmedText(next.category) || "General";
    next.fileUrl = asTrimmedText(next.fileUrl) || "private-hr-storage";
    next.version = asTrimmedText(next.version) || "1.0";
    next.requiresSignature = asBoolean(next.requiresSignature) ?? false;
    next.requiredReading = asBoolean(next.requiredReading) ?? false;
    next.expiresAt = normaliseDate(next.expiresAt);
    next.status = asTrimmedText(next.status)?.toLowerCase() || "active";
  } else if (resourceName === "jobs") {
    next = withAliases(next, {
      title: ["jobTitle", "role", "position", "name"],
      closingDate: ["closing_date", "deadline"],
      applicants: ["applicantCount"]
    });
    next.title = asTrimmedText(next.title) || "Open role";
    next.department = asTrimmedText(next.department) || "General";
    next.location = asTrimmedText(next.location) || "Hybrid";
    next.closingDate = normaliseDate(next.closingDate);
    next.status = asTrimmedText(next.status)?.toLowerCase() || "open";
    next.applicants = asInteger(next.applicants) ?? 0;
  } else if (resourceName === "candidates") {
    next = withAliases(next, {
      name: ["fullName", "applicantName", "candidateName"],
      email: ["emailAddress"],
      jobTitle: ["job_title", "role", "position", "job"],
      websiteApplicationId: ["website_application_id", "applicationId"],
      resumeUrl: ["resume_url", "cvUrl", "cv", "fileUrl"],
      offerStatus: ["offer_status"]
    });
    next.name = asTrimmedText(next.name) || "Applicant";
    next.email = asLowerEmail(next.email);
    next.jobTitle = asTrimmedText(next.jobTitle) || "Application";
    next.source = asTrimmedText(next.source) || "HR portal";
    next.stage = asTrimmedText(next.stage)?.toLowerCase() || "screening";
    next.status = asTrimmedText(next.status)?.toLowerCase() || "active";
    next.rating = asInteger(next.rating);
  } else if (resourceName === "learning") {
    next = withAliases(next, {
      title: ["name", "courseName"],
      courseUrl: ["course_url", "url", "link"],
      videoUrl: ["video_url"],
      pdfUrl: ["pdf_url"],
      presentationUrl: ["presentation_url"],
      imageUrl: ["image_url"],
      certificateEnabled: ["certificate_enabled", "issueCertificate"],
      assessmentRequired: ["assessment_required", "requiresAssessment"],
      durationMinutes: ["duration_minutes", "duration", "minutes"],
      dueDays: ["due_days"],
      rolePermission: ["role_permission", "role", "audienceRole"],
      handbookContent: ["handbook_content", "content", "body"],
      passMark: ["pass_mark"],
      featured: ["isFeatured"]
    });
    next.title = asTrimmedText(next.title) || "Learning course";
    next.category = asTrimmedText(next.category) || "General";
    next.format = asTrimmedText(next.format);
    next.description = asTrimmedText(next.description) || "TitoPay staff learning content.";
    next.overview = asTrimmedText(next.overview);
    next.level = asTrimmedText(next.level);
    next.department = asTrimmedText(next.department);
    next.rolePermission = asTrimmedText(next.rolePermission);
    if (typeof next.tags === "string") next.tags = next.tags.split(",").map((tag) => tag.trim()).filter(Boolean);
    if (!Array.isArray(next.tags)) next.tags = [];
    next.durationMinutes = asInteger(next.durationMinutes) ?? 30;
    next.dueDays = asInteger(next.dueDays);
    next.featured = asBoolean(next.featured) ?? false;
    next.handbookContent = asTrimmedText(next.handbookContent);
    next.passMark = asInteger(next.passMark) ?? 80;
    next.courseUrl = asTrimmedText(next.courseUrl) || "hr-learning";
    next.videoUrl = asTrimmedText(next.videoUrl);
    next.pdfUrl = asTrimmedText(next.pdfUrl);
    next.presentationUrl = asTrimmedText(next.presentationUrl);
    next.imageUrl = asTrimmedText(next.imageUrl);
    next.certificateEnabled = asBoolean(next.certificateEnabled) ?? false;
    next.mandatory = asBoolean(next.mandatory) ?? false;
    next.assessmentRequired = asBoolean(next.assessmentRequired) ?? false;
    next.status = asTrimmedText(next.status)?.toLowerCase() || "active";
  }

  Object.keys(next).forEach((key) => {
    if (next[key] === undefined) delete next[key];
  });
  return next;
}

function rowToApi(row) {
  const out = {};
  Object.entries(row).forEach(([key, value]) => {
    out[toCamel(key)] = value;
  });
  if (out.firstName || out.lastName) out.name = `${out.firstName || ""} ${out.lastName || ""}`.trim();
  return out;
}

const resourceAliases = {
  organisation: "departments",
  organization: "departments",
  "employee-documents": "uploads",
  "company-documents": "documents",
  "leave-requests": "leave",
  "attendance-records": "attendance",
  "payroll-records": "payroll",
  "performance-reviews": "performance",
  "disciplinary-cases": "disciplinary",
  "audit-logs": "audit",
  "learning-courses": "learning",
  courses: "learning",
  course: "learning",
  "learning-hub": "learning",
  training: "learning",
  lessons: "learning-lessons",
  modules: "learning-modules",
  "course-modules": "learning-modules",
  "course-lessons": "learning-lessons",
  certificates: "learning-certificates",
  "learning-certificates": "learning-certificates",
  progress: "learning-progress",
  "course-progress": "learning-progress",
  assignments: "learning-assignments",
  "course-assignments": "learning-assignments",
  "expense-claims": "expenses",
  "onboarding-tasks": "onboarding",
  "self-onboarding": "onboarding",
  "staff-onboarding": "onboarding",
  "hr-tickets": "tickets",
  "attendance-register": "attendance",
  apologies: "attendance",
  apology: "attendance",
  "work-hours": "employees",
  "working-hours": "employees",
  "offer-letters": "documents",
  "offer-letter": "documents",
  "employee-files": "uploads",
  files: "uploads",
  "recruitment-jobs": "jobs",
  "recruitment-candidates": "candidates",
  recruitment: "candidates",
  applications: "candidates",
  applicants: "candidates",
  application: "candidates",
  staff: "employees",
  "staff-members": "employees"
};

function resolveResourceName(name) {
  const raw = String(name || "").trim();
  const normalized = raw.toLowerCase().replace(/_/g, "-");
  return resources[raw]
    ? raw
    : resources[normalized]
      ? normalized
      : resourceAliases[normalized] || resourceAliases[raw] || raw;
}

function assertResource(name) {
  const resourceName = resolveResourceName(name);
  const config = resources[resourceName];
  if (!config) throw new AppError(404, "Unknown HR resource");
  return config;
}

// Which columns identify the owner of a row, per resource.
//
// Without this, a role holding only `leave:self` could list, edit and delete
// EVERY employee's leave, claims, tickets and performance reviews — the
// permission layer said "self" and no query ever enforced it. Only employees,
// onboarding and attendance were scoped, and only when listing.
//
// A resource absent from this map is not self-scopable: if a role somehow holds
// `:self` on it, ownerFilter refuses rather than returning everything, because
// failing closed is the only safe default for personnel data.
const OWNERSHIP = {
  employees: { email: "email" },
  onboarding: { employeeId: "employee_id", name: "employee" },
  attendance: { employeeId: "employee_id", name: "employee" },
  leave: { employeeId: "employee_id", name: "employee" },
  performance: { employeeId: "employee_id", name: "employee" },
  expenses: { name: "employee" },
  tickets: { userId: "requester_id", name: "requester" },
  learning: { employeeId: "employee_id", userId: "user_id" }
};

// Builds the SQL that limits a query to rows this person owns, appending its
// bound values to `values`. Returns "" when the role is not self-scoped.
function ownerFilter(auth, resourceName, values) {
  const config = resources[resourceName];
  if (!config) return "";
  if (hrGrantScope(auth.role, config.module) !== "self") return "";

  const map = OWNERSHIP[resourceName];
  if (!map) {
    // Fail closed. A self-scoped role on a resource we cannot scope must see
    // nothing, not everything.
    return " AND FALSE";
  }
  const clauses = [];
  if (map.employeeId && auth.employeeId) {
    values.push(auth.employeeId);
    clauses.push(`${map.employeeId} = $${values.length}`);
  }
  if (map.userId && auth.userId) {
    values.push(auth.userId);
    clauses.push(`${map.userId} = $${values.length}`);
  }
  if (map.email && auth.email) {
    values.push(auth.email);
    clauses.push(`lower(${map.email}) = lower($${values.length})`);
  }
  // The name column is a free-text fallback for rows written before employee_id
  // existed. It is deliberately last and never the only match when an id is
  // available, because names are not identities — see F-06 and F-16.
  if (map.name) {
    if (auth.name) {
      values.push(auth.name);
      clauses.push(`lower(${map.name}) = lower($${values.length})`);
    }
    if (auth.email) {
      values.push(auth.email);
      clauses.push(`lower(${map.name}) = lower($${values.length})`);
    }
  }
  if (!clauses.length) return " AND FALSE";
  return ` AND (${clauses.join(" OR ")})`;
}

function assertPermission(auth, config, action) {
  if (!hasHrPermission(auth.role, config.module, action)) {
    throw new AppError(403, `You do not have permission to ${action} ${config.module} records`);
  }
}

async function audit(auth, action, entity, detail, metadata = {}) {
  await pool.query(
    `INSERT INTO hr_audit_logs (user_id, user_email, action, entity, detail, ip_address, user_agent, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [auth?.userId || null, auth?.email || "system", action, entity, String(detail || ""), metadata.ip || null, metadata.userAgent || null, metadata]
  );
}

function normaliseAction(action) {
  const value = String(action || "toggle").toLowerCase().replace(/[\s-]+/g, "_");
  if (["clock_in", "sign_in", "in"].includes(value)) return "clock_in";
  if (["clock_out", "sign_out", "out"].includes(value)) return "clock_out";
  if (["lunch_start", "lunch_out", "break_start"].includes(value)) return "lunch_start";
  if (["lunch_end", "lunch_back", "break_end"].includes(value)) return "lunch_end";
  if (["apology", "apologies", "absent_apology"].includes(value)) return "apology";
  return "toggle";
}

function timeToMinutes(value, fallback) {
  const text = String(value || fallback || "08:00");
  const [hour, minute] = text.split(":").map((part) => Number(part));
  return (Number.isFinite(hour) ? hour : 8) * 60 + (Number.isFinite(minute) ? minute : 0);
}

function johannesburgDateParts(value) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Johannesburg",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short"
  }).formatToParts(new Date(value));
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function dateAtWorkMinutes(baseDate, minutes) {
  const parts = johannesburgDateParts(baseDate);
  // Africa/Johannesburg is UTC+02:00 year-round (no daylight saving time).
  return new Date(Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Math.floor(minutes / 60) - 2,
    minutes % 60,
    0,
    0
  ));
}

function minutesBetween(start, end) {
  if (!start || !end) return 0;
  return Math.max(0, Math.round((new Date(end).getTime() - new Date(start).getTime()) / 60000));
}

async function employeeContract(auth, employeeName) {
  const clauses = [];
  const values = [];
  if (auth.employeeId) {
    values.push(auth.employeeId);
    clauses.push(`id = $${values.length}`);
  }
  if (auth.email) {
    values.push(auth.email);
    clauses.push(`lower(email) = lower($${values.length})`);
  }
  if (employeeName) {
    values.push(employeeName);
    clauses.push(`lower(concat_ws(' ', first_name, last_name)) = lower($${values.length})`);
  }
  if (!clauses.length) return null;
  const result = await pool.query(
    `SELECT id, concat_ws(' ', first_name, last_name) AS employee_name, work_start_time, work_end_time, lunch_minutes, hourly_rate, contract_hours_per_week
       FROM hr_employees
      WHERE deleted_at IS NULL AND (${clauses.join(" OR ")})
      ORDER BY updated_at DESC
      LIMIT 1`,
    values
  );
  return result.rows[0] || null;
}

function attendanceTotals(row, contract, now = new Date()) {
  const clockIn = row.clock_in ? new Date(row.clock_in) : null;
  const clockOut = row.clock_out ? new Date(row.clock_out) : now;
  const breakMinutes = row.lunch_start && row.lunch_end ? minutesBetween(row.lunch_start, row.lunch_end) : Number(row.break_minutes || 0);
  const worked = Math.max(0, minutesBetween(clockIn, clockOut) - breakMinutes);
  const startMinutes = timeToMinutes(contract?.work_start_time, "08:00");
  const endMinutes = timeToMinutes(contract?.work_end_time, "17:00");
  const workDate = clockIn || now;
  const scheduledEnd = dateAtWorkMinutes(workDate, endMinutes);
  const weekday = johannesburgDateParts(workDate).weekday;
  const isWeekend = weekday === "Sat" || weekday === "Sun";
  const overtime = isWeekend ? worked : Math.max(0, Math.round((clockOut.getTime() - scheduledEnd.getTime()) / 60000));
  const regular = Math.max(0, worked - overtime);
  const late = clockIn && !isWeekend ? Math.max(0, Math.round((clockIn.getTime() - dateAtWorkMinutes(clockIn, startMinutes).getTime()) / 60000)) : 0;
  return { breakMinutes, regularMinutes: regular, overtimeMinutes: overtime, minutesLate: late };
}

async function health() {
  await pool.query("SELECT 1");
  return { ok: true };
}

function issueTokens(user, sessionId, accessJti) {
  const payload = { sub: user.id, sid: sessionId, email: user.email, role: user.role, scope: "hr", typ: "hr", jti: accessJti };
  return {
    accessToken: signAccessToken(payload),
    refreshToken: signRefreshToken({ sub: user.id, sid: sessionId, scope: "hr", typ: "hr" })
  };
}

async function login({ email, password }, meta = {}) {
  if (!email || !password) throw new AppError(400, "Email and password are required");
  const identifier = String(email).trim();
  const result = await pool.query(
    `SELECT u.id, u.email, u.name, u.role, u.password_hash, u.status, u.employee_id,
            u.failed_login_attempts, u.locked_until
       FROM hr_users u
       LEFT JOIN hr_employees e ON e.id = u.employee_id AND e.deleted_at IS NULL
      WHERE lower(u.email) = lower($1)
         OR lower(e.employee_number) = lower($1)
      LIMIT 1`,
    [identifier]
  );
  const user = result.rows[0];
  if (!user) throw new AppError(401, "Invalid email or password");
  if (user.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
    throw new AppError(423, "HR account is temporarily locked");
  }
  if (user.status !== "active") throw new AppError(403, "HR account is not active");

  const valid = await verifyPassword(password, user.password_hash);
  await pool.query(
    `INSERT INTO hr_login_history (user_id, email, ip_address, user_agent, success, failure_reason)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [user.id, user.email, meta.ip || null, meta.userAgent || null, valid, valid ? null : "invalid_credentials"]
  );

  if (!valid) {
    await pool.query(
      `UPDATE hr_users
          SET failed_login_attempts = failed_login_attempts + 1,
              locked_until = CASE WHEN failed_login_attempts + 1 >= 5 THEN NOW() + INTERVAL '15 minutes' ELSE locked_until END
        WHERE id = $1`,
      [user.id]
    );
    throw new AppError(401, "Invalid email or password");
  }

  const sessionId = crypto.randomUUID();
  const accessJti = crypto.randomUUID();
  const { accessToken, refreshToken } = issueTokens(user, sessionId, accessJti);
  await pool.query(
    `INSERT INTO hr_sessions (id, user_id, refresh_token_hash, access_jti, ip_address, user_agent, trusted_device, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW() + ($8 || ' days')::INTERVAL)`,
    [sessionId, user.id, tokenHash(refreshToken), accessJti, meta.ip || null, meta.userAgent || null, Boolean(meta.trustedDevice), refreshTokenDays]
  );
  await pool.query("UPDATE hr_users SET failed_login_attempts = 0, locked_until = NULL, last_login_at = NOW() WHERE id = $1", [user.id]);
  await audit(user, "Login", "authentication", "Successful HR login", meta);

  return {
    token: accessToken,
    accessToken,
    refreshToken,
    user: { id: user.id, employeeId: user.employee_id, name: user.name, email: user.email, role: user.role }
  };
}

async function refresh(refreshToken) {
  if (!refreshToken) throw new AppError(400, "Refresh token is required");
  const decoded = verifyRefreshToken(refreshToken);
  if (decoded.typ !== "hr" && decoded.scope !== "hr") throw new AppError(401, "Invalid HR refresh token");
  const result = await pool.query(
    `SELECT s.id AS session_id, s.user_id, s.refresh_token_hash, s.revoked_at, s.expires_at, u.id, u.email, u.name, u.role, u.status, u.employee_id
       FROM hr_sessions s
       JOIN hr_users u ON u.id = s.user_id
      WHERE s.id = $1
      LIMIT 1`,
    [decoded.sid]
  );
  const row = result.rows[0];
  if (!row || row.revoked_at || row.status !== "active" || row.refresh_token_hash !== tokenHash(refreshToken)) {
    throw new AppError(401, "Invalid HR refresh token");
  }
  const accessJti = crypto.randomUUID();
  const tokens = issueTokens(row, row.session_id, accessJti);
  await pool.query("UPDATE hr_sessions SET refresh_token_hash = $1, access_jti = $2, last_seen_at = NOW() WHERE id = $3", [tokenHash(tokens.refreshToken), accessJti, row.session_id]);
  return { ...tokens, token: tokens.accessToken, user: { id: row.id, employeeId: row.employee_id, name: row.name, email: row.email, role: row.role } };
}

async function logout(auth) {
  await pool.query("UPDATE hr_sessions SET revoked_at = NOW() WHERE id = $1", [auth.sessionId]);
  await audit(auth, "Logout", "authentication", "HR session ended");
}

async function safeDashboardQuery(sql, fallbackRows = [{}], values = []) {
  try {
    return await pool.query(sql, values);
  } catch (error) {
    console.error("[hr-dashboard-query-error]", {
      message: error.message,
      sql: String(sql).replace(/\s+/g, " ").slice(0, 220)
    });
    return { rows: fallbackRows, rowCount: fallbackRows.length };
  }
}

async function ensureLearningDefaults() {
  const courses = [
    ["TitoPay Staff Onboarding", "Onboarding", "Mandatory introduction to TitoPay, staff conduct, remote work expectations and secure internal systems.", true, true, true, 90, 7, ["onboarding", "mandatory"]],
    ["Employee Handbook", "Policies", "The TitoPay employee handbook covering staff responsibilities, working hours, leave, escalation paths and workplace standards.", true, false, true, 45, 14, ["handbook", "policy"]],
    ["Code of Conduct", "Governance", "Professional conduct, confidentiality, conflicts of interest, anti-harassment standards and ethical decision-making.", true, true, true, 40, 14, ["conduct", "ethics"]],
    ["POPIA and Privacy Awareness", "Compliance", "Practical privacy training for handling customer, staff and applicant personal information under POPIA.", true, true, true, 60, 14, ["popia", "privacy", "compliance"]],
    ["Cybersecurity Awareness", "Security", "Password safety, device protection, secure remote work and incident reporting for TitoPay staff.", true, true, true, 50, 14, ["cybersecurity", "security"]],
    ["Phishing Awareness", "Security", "How to identify phishing, suspicious links, social engineering and payment-related impersonation attempts.", true, true, false, 35, 14, ["phishing", "security"]],
    ["Information Security", "Security", "TitoPay information classification, access control, customer data handling and secure operational habits.", true, true, false, 45, 14, ["infosec", "security"]],
    ["Workplace Health and Safety", "Workforce", "Safety practices for office, hybrid and remote staff including incident reporting and safe work environments.", true, false, false, 30, 21, ["health", "safety"]],
    ["Diversity, Equity and Inclusion", "People", "Inclusive communication, respectful collaboration and fair workplace practices across TitoPay teams.", true, false, false, 30, 21, ["dei", "culture"]],
    ["Customer Service Excellence", "Support", "High-quality customer care, escalation handling, service tone and sensitive financial support scenarios.", true, true, true, 55, 21, ["support", "service"]],
    ["Anti-Fraud and AML Awareness", "Compliance", "Fraud indicators, suspicious activity escalation, customer due diligence basics and AML responsibilities.", true, true, true, 75, 14, ["aml", "fraud", "compliance"]],
    ["TitoPay Product Knowledge", "Product", "Core TitoPay services including wallets, QR payments, marketplace, ticketing, VAS, support and admin workflows.", false, true, true, 80, null, ["product", "titopay"]],
    ["HR Process Guides", "HR Operations", "How staff use leave, attendance, onboarding, claims, documents, support requests and HR self-service.", false, false, false, 35, null, ["hr", "process"]],
    ["Performance and Leadership", "Management", "Goal setting, feedback, performance reviews, team leadership and development planning.", false, true, false, 70, null, ["leadership", "performance"]]
  ];
  for (const [title, category, description, mandatory, assessmentRequired, featured, durationMinutes, dueDays, tags] of courses) {
    const result = await pool.query(
      `INSERT INTO hr_learning_courses
        (title, category, description, course_url, mandatory, assessment_required, status, featured, duration_minutes, due_days, tags, handbook_content, pass_mark)
       SELECT $1, $2, $3, 'hr-learning', $4, $5, 'active', $6, $7, $8, $9, $10, 80
       WHERE NOT EXISTS (
         SELECT 1 FROM hr_learning_courses
          WHERE lower(title) = lower($1) AND deleted_at IS NULL
       )
       RETURNING id`,
      [
        title,
        category,
        description,
        mandatory,
        assessmentRequired,
        featured,
        durationMinutes,
        dueDays,
        tags,
        `${title}\n\n${description}\n\nThis course is part of TitoPay's paperless HR learning programme. Employees must read the material, complete any assessment and keep evidence of completion in the HR Learning Hub.`
      ]
    );
    const courseId = result.rows[0]?.id;
    if (!courseId) continue;
    const module = await pool.query(
      `INSERT INTO hr_learning_modules (course_id, title, summary, sort_order)
       VALUES ($1, 'Core material', $2, 1)
       RETURNING id`,
      [courseId, description]
    );
    await pool.query(
      `INSERT INTO hr_learning_lessons (module_id, title, lesson_type, content, duration_minutes, sort_order)
       VALUES ($1, $2, 'article', $3, $4, 1)`,
      [module.rows[0].id, title, description, Math.max(10, Math.round(durationMinutes / 2))]
    );
    if (assessmentRequired) {
      const quiz = await pool.query(
        `INSERT INTO hr_learning_quizzes (course_id, title, pass_mark, max_attempts)
         VALUES ($1, $2, 80, 3)
         RETURNING id`,
        [courseId, `${title} assessment`]
      );
      await pool.query(
        `INSERT INTO hr_learning_quiz_questions (quiz_id, question, options, correct_answer, sort_order)
         VALUES ($1, $2, $3, 'Escalate through the approved TitoPay process', 1)`,
        [
          quiz.rows[0].id,
          "What should staff do when they are unsure how to handle a sensitive TitoPay matter?",
          JSON.stringify([
            "Ignore it until later",
            "Escalate through the approved TitoPay process",
            "Share details in an unofficial channel",
            "Use personal judgement without recording it"
          ])
        ]
      );
    }
  }
}

async function dashboard(auth) {
  const [employees, leave, attendance, payroll, onboarding, candidates, tickets, calendarRows, departmentRows, activityRows] = await Promise.all([
    safeDashboardQuery("SELECT COUNT(*)::int total, COALESCE(SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END),0)::int active FROM hr_employees WHERE deleted_at IS NULL", [{ total: 0, active: 0 }]),
    safeDashboardQuery("SELECT COALESCE(SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END),0)::int on_leave, COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END),0)::int pending FROM hr_leave_requests WHERE deleted_at IS NULL", [{ on_leave: 0, pending: 0 }]),
    safeDashboardQuery("SELECT COALESCE(SUM(CASE WHEN status = 'present' THEN 1 ELSE 0 END),0)::int present, COALESCE(SUM(CASE WHEN work_mode ILIKE 'remote%' THEN 1 ELSE 0 END),0)::int remote, COALESCE(SUM(CASE WHEN minutes_late > 0 THEN 1 ELSE 0 END),0)::int late, COALESCE(SUM(CASE WHEN status = 'absent' THEN 1 ELSE 0 END),0)::int absent FROM hr_attendance_records WHERE deleted_at IS NULL AND work_date::date = CURRENT_DATE", [{ present: 0, remote: 0, late: 0, absent: 0 }]),
    safeDashboardQuery("SELECT COALESCE(SUM(net_pay),0)::numeric total, COALESCE(SUM(CASE WHEN status IN ('draft','review') THEN 1 ELSE 0 END),0)::int pending FROM hr_payroll_records WHERE deleted_at IS NULL", [{ total: 0, pending: 0 }]),
    safeDashboardQuery("SELECT COALESCE(SUM(CASE WHEN status = 'complete' THEN 1 ELSE 0 END),0)::int complete, COALESCE(SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END),0)::int in_progress, COALESCE(SUM(CASE WHEN due_date < CURRENT_DATE AND status <> 'complete' THEN 1 ELSE 0 END),0)::int overdue FROM hr_onboarding_tasks WHERE deleted_at IS NULL", [{ complete: 0, in_progress: 0, overdue: 0 }]),
    safeDashboardQuery("SELECT COALESCE(SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END),0)::int active, COALESCE(SUM(CASE WHEN stage = 'offer' THEN 1 ELSE 0 END),0)::int offers FROM hr_recruitment_candidates WHERE deleted_at IS NULL", [{ active: 0, offers: 0 }]),
    safeDashboardQuery("SELECT COALESCE(SUM(CASE WHEN status <> 'resolved' THEN 1 ELSE 0 END),0)::int open FROM hr_tickets WHERE deleted_at IS NULL", [{ open: 0 }]),
    safeDashboardQuery("SELECT first_name, last_name, start_date FROM hr_employees WHERE deleted_at IS NULL AND status = 'active' AND start_date IS NOT NULL AND EXTRACT(MONTH FROM start_date) = EXTRACT(MONTH FROM CURRENT_DATE) LIMIT 8", []),
    safeDashboardQuery("SELECT COALESCE(department, 'Unassigned') AS name, COUNT(*)::int AS \"value\" FROM hr_employees WHERE deleted_at IS NULL GROUP BY department ORDER BY \"value\" DESC", []),
    safeDashboardQuery("SELECT user_email AS user, action, entity, detail, created_at FROM hr_audit_logs ORDER BY created_at DESC LIMIT 8", [])
  ]);

  return {
    staff: auth.role === "Employee",
    metrics: {
      totalEmployees: Number(employees.rows[0]?.total || 0),
      activeEmployees: Number(employees.rows[0]?.active || 0),
      newHires: 0,
      onLeave: Number(leave.rows[0]?.on_leave || 0),
      pendingApprovals: Number(leave.rows[0]?.pending || 0),
      recruitmentPipeline: Number(candidates.rows[0]?.active || 0),
      payrollPending: Number(payroll.rows[0]?.pending || 0),
      openTickets: Number(tickets.rows[0]?.open || 0)
    },
    attendance: attendance.rows[0] || { present: 0, remote: 0, late: 0, absent: 0 },
    payroll: payroll.rows[0] || { total: 0, pending: 0 },
    departments: departmentRows.rows,
    onboarding: onboarding.rows[0] || { complete: 0, in_progress: 0, overdue: 0 },
    recruitment: candidates.rows[0] || { active: 0, offers: 0 },
    birthdays: calendarRows.rows.map(rowToApi),
    anniversaries: calendarRows.rows.map(rowToApi),
    leaveTrend: [0, 0, 0, 0, 0, 0, Number(leave.rows[0]?.on_leave || 0)],
    charts: {
      headcount: departmentRows.rows,
      leaveTrend: [0, 0, 0, 0, 0, 0, Number(leave.rows[0]?.on_leave || 0)]
    },
    activities: activityRows.rows.map(rowToApi)
  };
}

async function learningDashboard(auth) {
  await ensureLearningDefaults();
  assertPermission(auth, resources.learning, "read");
  const [courses, enrolments, certificates, bookmarks] = await Promise.all([
    pool.query(
      `SELECT c.*,
              COALESCE(m.module_count, 0)::int AS module_count,
              COALESCE(l.lesson_count, 0)::int AS lesson_count,
              COALESCE(q.quiz_count, 0)::int AS quiz_count
         FROM hr_learning_courses c
         LEFT JOIN (
           SELECT course_id, COUNT(*) module_count
             FROM hr_learning_modules
            WHERE deleted_at IS NULL
            GROUP BY course_id
         ) m ON m.course_id = c.id
         LEFT JOIN (
           SELECT lm.course_id, COUNT(ll.*) lesson_count
             FROM hr_learning_modules lm
             LEFT JOIN hr_learning_lessons ll ON ll.module_id = lm.id AND ll.deleted_at IS NULL
            WHERE lm.deleted_at IS NULL
            GROUP BY lm.course_id
         ) l ON l.course_id = c.id
         LEFT JOIN (
           SELECT course_id, COUNT(*) quiz_count
             FROM hr_learning_quizzes
            WHERE deleted_at IS NULL
            GROUP BY course_id
         ) q ON q.course_id = c.id
        WHERE c.deleted_at IS NULL AND c.status = 'active'
        ORDER BY c.featured DESC, c.mandatory DESC, c.title ASC`
    ),
    pool.query(
      `SELECT e.*, c.title, c.category
         FROM hr_learning_enrolments e
         JOIN hr_learning_courses c ON c.id = e.course_id
        WHERE e.deleted_at IS NULL AND e.user_id = $1
        ORDER BY e.last_seen_at DESC`,
      [auth.userId]
    ),
    pool.query(
      `SELECT cert.*, c.title
         FROM hr_learning_certificates cert
         JOIN hr_learning_courses c ON c.id = cert.course_id
        WHERE cert.deleted_at IS NULL AND cert.user_id = $1
        ORDER BY cert.issued_at DESC`,
      [auth.userId]
    ),
    pool.query(
      `SELECT course_id
         FROM hr_learning_bookmarks
        WHERE deleted_at IS NULL AND user_id = $1`,
      [auth.userId]
    )
  ]);
  const bookmarkIds = new Set(bookmarks.rows.map((row) => String(row.course_id)));
  const courseData = courses.rows.map((row) => ({ ...rowToApi(row), bookmarked: bookmarkIds.has(String(row.id)) }));
  const enrolled = enrolments.rows.map(rowToApi);
  const completed = enrolled.filter((row) => row.status === "completed").length;
  return {
    data: {
      featured: courseData.filter((course) => course.featured).slice(0, 6),
      mandatory: courseData.filter((course) => course.mandatory),
      recommended: courseData.slice(0, 8),
      continueLearning: enrolled.filter((row) => row.status !== "completed").slice(0, 6),
      recentlyViewed: enrolled.slice(0, 6),
      courses: courseData,
      certificates: certificates.rows.map(rowToApi),
      progress: {
        enrolled: enrolled.length,
        completed,
        completionRate: enrolled.length ? Math.round((completed / enrolled.length) * 100) : 0
      },
      categories: [...new Set(courseData.map((course) => course.category).filter(Boolean))]
    }
  };
}

async function list(resourceName, auth, query = {}) {
  const effectiveResourceName = resolveResourceName(resourceName);
  const config = assertResource(resourceName);
  assertPermission(auth, config, "read");
  if (effectiveResourceName === "learning") await ensureLearningDefaults();
  const values = [];
  const filters = ["deleted_at IS NULL"];
  if (query.q && config.searchable.length) {
    values.push(`%${String(query.q).toLowerCase()}%`);
    filters.push(`(${config.searchable.map((column) => `LOWER(COALESCE(${column}::text,'')) LIKE $${values.length}`).join(" OR ")})`);
  }
  if (query.status && query.status !== "all" && config.columns.status) {
    const normalizedStatus = normaliseStatus(query.status, ["active", "suspended", "resigned", "terminated", "pending", "in_progress", "complete", "overdue", "present", "absent", "apology", "lunch", "open", "resolved", "draft", "submitted", "approved", "rejected"], String(query.status).toLowerCase());
    values.push(normalizedStatus);
    filters.push(`${config.columns.status} = $${values.length}`);
  }
  // One rule for every self-scoped resource, instead of three hand-written
  // blocks that between them covered employees, onboarding and attendance and
  // silently left leave, claims, tickets, performance and learning open.
  const ownership = ownerFilter(auth, effectiveResourceName, values);
  if (ownership) filters.push(ownership.replace(/^ AND /, ""));

  const limit = Math.min(Number(query.limit || 50), 200);
  const offset = Math.max(Number(query.offset || 0), 0);
  values.push(limit, offset);
  const result = await pool.query(
    `SELECT * FROM ${config.table} WHERE ${filters.join(" AND ")} ORDER BY ${config.defaultOrder} LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values
  );
  return { data: result.rows.map(rowToApi), pagination: { limit, offset, count: result.rowCount } };
}

async function enrolLearning(courseId, auth, meta = {}) {
  await ensureLearningDefaults();
  assertPermission(auth, resources.learning, "write");
  const course = await pool.query("SELECT id, title FROM hr_learning_courses WHERE id = $1 AND deleted_at IS NULL", [courseId]);
  if (!course.rows[0]) throw new AppError(404, "Learning course not found");
  const result = await pool.query(
    `INSERT INTO hr_learning_enrolments (course_id, employee_id, user_id, status, progress_percent)
     VALUES ($1, $2, $3, 'enrolled', 0)
     ON CONFLICT (course_id, user_id) DO UPDATE
       SET deleted_at = NULL, status = COALESCE(hr_learning_enrolments.status, 'enrolled'), last_seen_at = NOW(), updated_at = NOW()
     RETURNING *`,
    [courseId, auth.employeeId || null, auth.userId]
  );
  await audit(auth, "Enrolled in learning course", "learning", course.rows[0].title, meta);
  return { ok: true, data: rowToApi(result.rows[0]) };
}

async function updateLearningProgress(courseId, auth, payload = {}, meta = {}) {
  await ensureLearningDefaults();
  assertPermission(auth, resources.learning, "write");
  const progress = Math.max(0, Math.min(100, asInteger(payload.progressPercent ?? payload.progress ?? 0) ?? 0));
  const status = progress >= 100 ? "completed" : "in_progress";
  const result = await pool.query(
    `INSERT INTO hr_learning_enrolments (course_id, employee_id, user_id, status, progress_percent, completed_at)
     VALUES ($1, $2, $3, $4, $5, CASE WHEN $5 >= 100 THEN NOW() ELSE NULL END)
     ON CONFLICT (course_id, user_id) DO UPDATE
       SET status = EXCLUDED.status,
           progress_percent = EXCLUDED.progress_percent,
           completed_at = CASE WHEN EXCLUDED.progress_percent >= 100 THEN COALESCE(hr_learning_enrolments.completed_at, NOW()) ELSE hr_learning_enrolments.completed_at END,
           last_seen_at = NOW(),
           updated_at = NOW(),
           deleted_at = NULL
     RETURNING *`,
    [courseId, auth.employeeId || null, auth.userId, status, progress]
  );
  await audit(auth, "Updated learning progress", "learning", `${courseId}: ${progress}%`, meta);
  return { ok: true, data: rowToApi(result.rows[0]) };
}

async function issueLearningCertificate(courseId, auth, payload = {}, meta = {}) {
  await ensureLearningDefaults();
  assertPermission(auth, resources.learning, "write");
  const course = await pool.query("SELECT id, title FROM hr_learning_courses WHERE id = $1 AND deleted_at IS NULL", [courseId]);
  if (!course.rows[0]) throw new AppError(404, "Learning course not found");
  const certificateNumber = `TPHR-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${crypto.randomInt(100000, 999999)}`;
  const result = await pool.query(
    `INSERT INTO hr_learning_certificates (course_id, employee_id, user_id, certificate_number, score, file_url, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'issued')
     RETURNING *`,
    [courseId, auth.employeeId || null, auth.userId, certificateNumber, asNumber(payload.score) ?? null, payload.fileUrl || null]
  );
  await updateLearningProgress(courseId, auth, { progressPercent: 100 }, meta);
  await audit(auth, "Issued learning certificate", "learning", certificateNumber, meta);
  return { ok: true, data: rowToApi(result.rows[0]) };
}

async function toggleLearningBookmark(courseId, auth) {
  await ensureLearningDefaults();
  assertPermission(auth, resources.learning, "read");
  const existing = await pool.query(
    "SELECT id, deleted_at FROM hr_learning_bookmarks WHERE course_id = $1 AND user_id = $2 LIMIT 1",
    [courseId, auth.userId]
  );
  if (existing.rows[0] && !existing.rows[0].deleted_at) {
    await pool.query("UPDATE hr_learning_bookmarks SET deleted_at = NOW(), updated_at = NOW() WHERE id = $1", [existing.rows[0].id]);
    return { ok: true, bookmarked: false };
  }
  await pool.query(
    `INSERT INTO hr_learning_bookmarks (course_id, user_id)
     VALUES ($1, $2)
     ON CONFLICT (course_id, user_id) DO UPDATE SET deleted_at = NULL, updated_at = NOW()`,
    [courseId, auth.userId]
  );
  return { ok: true, bookmarked: true };
}

async function create(resourceName, auth, payload, meta = {}) {
  const effectiveResourceName = resolveResourceName(resourceName);
  const config = assertResource(resourceName);
  if (config.readOnly) throw new AppError(405, "This HR resource is read-only");
  assertPermission(auth, config, "write");
  const normalizedPayload = normaliseHrPayload(effectiveResourceName, payload, auth);
  const data = cleanPayload(normalizedPayload, config);
  if (effectiveResourceName === "projects") {
    data.owner = data.owner || auth.name || auth.email || "HR";
    data.priority = data.priority || "normal";
    data.status = data.status || "active";
  }
  if (effectiveResourceName === "help") {
    data.requester = data.requester || auth.name || auth.email || "HR";
    data.type = data.type || "help";
    data.subject = data.subject || payload.title || "HR help request";
    data.priority = data.priority || "normal";
    data.status = data.status || "open";
  }
  if (effectiveResourceName === "meetings") {
    data.title = data.title || "HR meeting";
    data.status = data.status || "scheduled";
  }
  if (effectiveResourceName === "uploads") {
    data.title = data.title || normalizedPayload.fileName || normalizedPayload.name || "HR document";
    data.category = data.category || "General";
    data.file_url = data.file_url || normalizedPayload.fileUrl || normalizedPayload.url || "private-hr-storage";
    data.status = data.status || "active";
  }
  if (auth.role === "Employee" && effectiveResourceName === "onboarding") {
    data.employee = auth.name || auth.email;
    if (auth.employeeId) data.employee_id = auth.employeeId;
    data.status = data.status || "in_progress";
  }
  if (effectiveResourceName === "onboarding") {
    data.employee = data.employee || auth.name || auth.email || "Staff member";
    data.title = data.title || "Self onboarding";
    data.category = data.category || "Self onboarding";
    data.status = data.status || "in_progress";
  }
  if (effectiveResourceName === "attendance") {
    data.employee = data.employee || auth.name || auth.email || "Staff member";
    data.work_date = data.work_date || new Date().toISOString().slice(0, 10);
    data.work_mode = data.work_mode || "Office";
    data.status = data.status || "present";
    data.attendance_source = data.attendance_source || "hr-portal";
  }
  if (effectiveResourceName === "documents") {
    data.title = data.title || "HR document";
    data.category = data.category || "General";
    data.version = data.version || "1.0";
    data.file_url = data.file_url || "private-hr-storage";
    data.status = data.status || "active";
  }
  if (effectiveResourceName === "employees" && !data.employee_number) {
    const count = await pool.query("SELECT COUNT(*)::int AS \"value\" FROM hr_employees");
    data.employee_number = `TP-${String(count.rows[0].value + 1).padStart(3, "0")}`;
  }
  if (effectiveResourceName === "employees") {
    if (!data.first_name) throw new AppError(400, "First name is required");
    if (!data.last_name) throw new AppError(400, "Last name is required");
    if (!data.email) throw new AppError(400, "Work email is required");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) throw new AppError(400, "Work email is invalid");
    if (!data.job_title) throw new AppError(400, "Job title is required");
    if (!data.department) throw new AppError(400, "Department is required");
    data.status = data.status || "active";
    data.employment_type = data.employment_type || "Permanent";
    data.hourly_rate = data.hourly_rate ?? 0;
    data.contract_hours_per_week = data.contract_hours_per_week ?? 40;
    data.work_start_time = data.work_start_time || "08:00";
    data.work_end_time = data.work_end_time || "17:00";
    data.lunch_minutes = data.lunch_minutes ?? 60;
  }
  if (effectiveResourceName === "payroll") {
    const duplicate = await pool.query(
      `SELECT id
         FROM hr_payroll_records
        WHERE lower(employee) = lower($1)
          AND period = $2
          AND deleted_at IS NULL
        LIMIT 1`,
      [data.employee, data.period]
    );
    if (duplicate.rows[0]) throw new AppError(409, "A payroll record already exists for this employee and period");
  }
  const keys = Object.keys(data);
  if (!keys.length) throw new AppError(400, "No valid HR fields supplied");
  const params = keys.map((_, index) => `$${index + 1}`);
  let returning;
  if (effectiveResourceName === "employees") {
    const values = keys.map((key) => data[key]);
    const updateKeys = keys.filter((key) => !["id", "email", "employee_number", "created_at"].includes(key));
    const assignments = updateKeys.map((key) => `${key} = EXCLUDED.${key}`);
    assignments.push("deleted_at = NULL", "updated_at = NOW()");
    try {
      returning = await pool.query(
        `INSERT INTO hr_employees (${keys.join(", ")}) VALUES (${params.join(", ")}) RETURNING *`,
        values
      );
    } catch (error) {
      if (error.code === "23505") throw new AppError(409, "An employee with this email or employee number already exists");
      throw error;
    }
  } else {
    returning = await pool.query(
      `INSERT INTO ${config.table} (${keys.join(", ")}) VALUES (${params.join(", ")}) RETURNING *`,
      keys.map((key) => data[key])
    );
  }
  if (effectiveResourceName === "employees" && normalizedPayload.temporaryPassword && data.email) {
    const employee = returning.rows[0];
    const fullName = `${employee.first_name || ""} ${employee.last_name || ""}`.trim() || employee.email;
    const passwordHash = await hashPassword(String(normalizedPayload.temporaryPassword));
    await pool.query(
      `INSERT INTO hr_users (employee_id, name, email, role, password_hash, status)
       VALUES ($1, $2, $3, 'Employee', $4, 'active')
       ON CONFLICT (email) DO UPDATE
         SET employee_id = EXCLUDED.employee_id,
             name = EXCLUDED.name,
             password_hash = EXCLUDED.password_hash,
             status = 'active',
             updated_at = NOW()`,
      [employee.id, fullName, employee.email, passwordHash]
    );
  }
  await audit(auth, "Created record", resourceName, normalizedPayload.email || normalizedPayload.title || normalizedPayload.subject || normalizedPayload.employee || returning.rows[0].id, meta);
  return { data: rowToApi(returning.rows[0]) };
}

async function update(resourceName, id, auth, payload, meta = {}) {
  const effectiveResourceName = resolveResourceName(resourceName);
  const config = assertResource(resourceName);
  if (config.readOnly) throw new AppError(405, "This HR resource is read-only");
  assertPermission(auth, config, "write");
  const normalizedPayload = normaliseHrPayload(effectiveResourceName, payload, auth);
  const data = cleanPayload(normalizedPayload, config);
  const keys = Object.keys(data);
  if (!keys.length) throw new AppError(400, "No valid HR fields supplied");
  const assignments = keys.map((key, index) => `${key} = $${index + 1}`);
  const updateValues = keys.map((key) => data[key]);
  updateValues.push(id);
  // Scoped for every self-scoped resource, not just onboarding. Without this a
  // person holding expenses:self could PATCH ANY claim by id — including its
  // approval fields — which is exactly the self-approval risk in F-08, and could
  // edit another employee's leave, ticket or performance review.
  const ownershipFilter = ownerFilter(auth, effectiveResourceName, updateValues);

  const result = await pool.query(
    `UPDATE ${config.table} SET ${assignments.join(", ")}, updated_at = NOW() WHERE id = $${keys.length + 1} AND deleted_at IS NULL${ownershipFilter} RETURNING *`,
    updateValues
  );
  if (!result.rows[0]) throw new AppError(404, "HR record not found");
  await audit(auth, "Updated record", resourceName, normalizedPayload.email || normalizedPayload.title || normalizedPayload.subject || normalizedPayload.employee || id, meta);
  return { data: rowToApi(result.rows[0]) };
}

async function remove(resourceName, id, auth, meta = {}) {
  const effectiveResourceName = resolveResourceName(resourceName);
  const config = assertResource(resourceName);
  if (config.readOnly) throw new AppError(405, "This HR resource is read-only");
  assertPermission(auth, config, "delete");
  // Deletion had no ownership check at all: a self-scoped role could soft-delete
  // any record in a module it held, including other people's claims and leave.
  const removeValues = [id];
  const ownershipFilter = ownerFilter(auth, effectiveResourceName, removeValues);
  const result = await pool.query(
    `UPDATE ${config.table} SET deleted_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND deleted_at IS NULL${ownershipFilter} RETURNING id`, removeValues);
  if (!result.rows[0]) throw new AppError(404, "HR record not found");
  await audit(auth, "Deleted record", resourceName, id, meta);
  return { ok: true };
}

async function leaveDecision(id, auth, decision, comment, meta = {}) {
  assertPermission(auth, resources.leave, "write");
  if (!["approved", "rejected", "cancelled"].includes(decision)) throw new AppError(400, "Invalid leave decision");
  const result = await pool.query(
    "UPDATE hr_leave_requests SET status = $1, manager_comment = COALESCE($2, manager_comment), approved_by = $3, updated_at = NOW() WHERE id = $4 AND deleted_at IS NULL RETURNING *",
    [decision, comment || null, auth.userId, id]
  );
  if (!result.rows[0]) throw new AppError(404, "Leave request not found");
  await audit(auth, "Leave decision", "leave", `${decision}: ${id}`, meta);
  return { data: rowToApi(result.rows[0]) };
}

async function clock(auth, payload = {}, meta = {}) {
  const requestedName = payload.fullName || payload.employee || auth.name || auth.email;
  const contract = await employeeContract(auth, requestedName);
  // Keep self-service attendance aligned with the authenticated HR identity.
  // The portal uses this value to detect an open session after a reload.
  const name = payload.fullName || auth.name || contract?.employee_name || requestedName;
  const action = normaliseAction(payload.action);
  const existing = await pool.query(
    `SELECT *
       FROM hr_attendance_records
      WHERE (employee = $1 OR employee_id = $2)
        AND work_date::date = (NOW() AT TIME ZONE 'Africa/Johannesburg')::date
        AND deleted_at IS NULL
      ORDER BY created_at DESC
      LIMIT 1`,
    [name, contract?.id || auth.employeeId || null]
  );
  let row = existing.rows[0];
  const signature = payload.fullName || auth.name || auth.email;

  if (action === "apology") {
    if (row) {
      const result = await pool.query(
        `UPDATE hr_attendance_records
            SET status = 'apology',
                apology_reason = $2,
                employee_signature = COALESCE($3, employee_signature),
                updated_at = NOW()
          WHERE id = $1
          RETURNING *`,
        [row.id, payload.reason || payload.apologyReason || "Apology submitted", signature]
      );
      row = result.rows[0];
    } else {
      const result = await pool.query(
        `INSERT INTO hr_attendance_records (employee_id, employee, work_date, work_mode, status, apology_reason, employee_signature, attendance_source)
         VALUES ($1, $2, (NOW() AT TIME ZONE 'Africa/Johannesburg')::date, $3, 'apology', $4, $5, 'hr-portal')
         RETURNING *`,
        [contract?.id || auth.employeeId || null, name, payload.workMode || "Remote", payload.reason || payload.apologyReason || "Apology submitted", signature]
      );
      row = result.rows[0];
    }
    await audit(auth, "Submitted apology", "attendance", name, meta);
    return { data: rowToApi(row), ok: true };
  }

  const hasOpenSession = Boolean(row?.clock_in && !row?.clock_out);
  if ((action === "clock_out" || action === "lunch_start" || action === "lunch_end") && !hasOpenSession) {
    throw new AppError(409, action === "clock_out" ? "No open attendance session was found" : "Clock in before recording a break");
  }
  if (action === "clock_in" && hasOpenSession) {
    throw new AppError(409, "An attendance session is already open");
  }
  if (action === "toggle" && row?.clock_out) {
    throw new AppError(409, "Today's attendance session is already complete");
  }

  if (!row) {
    const result = await pool.query(
      `INSERT INTO hr_attendance_records (employee_id, employee, work_date, clock_in, work_mode, status, minutes_late, employee_signature, attendance_source)
       VALUES ($1, $2, (NOW() AT TIME ZONE 'Africa/Johannesburg')::date, NOW(), $3, 'present', 0, $4, 'hr-portal')
       RETURNING *`,
      [contract?.id || auth.employeeId || null, name, payload.workMode || "Office", signature]
    );
    row = result.rows[0];
    await audit(auth, "Attendance clock_in", "attendance", name, meta);
    return {
      data: rowToApi(row),
      ok: true,
      action: "clocked_in",
      message: "Clock-in recorded"
    };
  }

  if (action === "lunch_start") {
    const result = await pool.query(
      "UPDATE hr_attendance_records SET lunch_start = COALESCE(lunch_start, NOW()), status = 'lunch', updated_at = NOW() WHERE id = $1 RETURNING *",
      [row.id]
    );
    row = result.rows[0];
  } else if (action === "lunch_end") {
    const result = await pool.query(
      `UPDATE hr_attendance_records
          SET lunch_end = NOW(),
              break_minutes = CASE WHEN lunch_start IS NOT NULL THEN GREATEST(0, ROUND(EXTRACT(EPOCH FROM (NOW() - lunch_start)) / 60)::int) ELSE break_minutes END,
              status = 'present',
              updated_at = NOW()
        WHERE id = $1
        RETURNING *`,
      [row.id]
    );
    row = result.rows[0];
  } else if (action === "clock_out" || (action === "toggle" && row.clock_in && !row.clock_out)) {
    const totals = attendanceTotals(row, contract);
    const result = await pool.query(
      `UPDATE hr_attendance_records
          SET clock_out = COALESCE(clock_out, NOW()),
              break_minutes = $2,
              regular_minutes = $3,
              overtime_minutes = $4,
              minutes_late = $5,
              status = 'complete',
              employee_signature = COALESCE($6, employee_signature),
              updated_at = NOW()
        WHERE id = $1
        RETURNING *`,
      [row.id, totals.breakMinutes, totals.regularMinutes, totals.overtimeMinutes, totals.minutesLate, signature]
    );
    row = result.rows[0];
  } else {
    const totals = attendanceTotals(row, contract);
    const result = await pool.query(
      `UPDATE hr_attendance_records
          SET clock_in = COALESCE(clock_in, NOW()),
              minutes_late = $2,
              employee_signature = COALESCE($3, employee_signature),
              work_mode = COALESCE($4, work_mode),
              status = 'present',
              updated_at = NOW()
        WHERE id = $1
        RETURNING *`,
      [row.id, totals.minutesLate, signature, payload.workMode || null]
    );
    row = result.rows[0];
  }

  await audit(auth, `Attendance ${action}`, "attendance", name, meta);
  const completed = Boolean(row.clock_out);
  return {
    data: rowToApi(row),
    ok: true,
    action: completed ? "clocked_out" : action,
    message: completed ? "Clock-out recorded" : action === "lunch_start" ? "Break started" : action === "lunch_end" ? "Break ended" : "Attendance updated"
  };
}

async function receiveWebsiteApplication(payload = {}, meta = {}) {
  const name = String(payload.name || `${payload.firstName || ""} ${payload.lastName || ""}`.trim()).trim();
  const email = String(payload.email || "").trim().toLowerCase();
  const jobTitle = String(payload.jobTitle || payload.role || payload.position || "").trim();
  if (!name) throw new AppError(400, "Applicant full name is required");
  if (!email) throw new AppError(400, "Applicant email is required");
  if (!jobTitle) throw new AppError(400, "Role applied for is required");

  const notes = [
    payload.notes,
    payload.message,
    payload.coverLetter,
    payload.experience ? `Experience: ${payload.experience}` : "",
    payload.availability ? `Availability: ${payload.availability}` : ""
  ].filter(Boolean).join("\n\n");

  const websiteApplicationId = String(payload.id || payload.applicationId || payload.websiteApplicationId || crypto.randomUUID());
  const result = await pool.query(
    `INSERT INTO hr_recruitment_candidates
       (name, email, job_title, source, phone, qualification, portfolio, website_application_id, stage, notes, status)
     VALUES ($1, $2, $3, 'Marketing website', $4, $5, $6, $7, 'screening', $8, 'active')
     ON CONFLICT (website_application_id) WHERE website_application_id IS NOT NULL DO UPDATE
       SET name = EXCLUDED.name,
           email = EXCLUDED.email,
           job_title = EXCLUDED.job_title,
           phone = EXCLUDED.phone,
           qualification = EXCLUDED.qualification,
           portfolio = EXCLUDED.portfolio,
           notes = EXCLUDED.notes,
           updated_at = NOW()
     RETURNING *`,
    [name, email, jobTitle, payload.phone || null, payload.qualification || null, payload.portfolio || payload.portfolioUrl || null, websiteApplicationId, notes || null]
  );
  await audit({ email: "marketing-website" }, "Received website application", "recruitment", `${name} - ${jobTitle}`, meta);
  return { ok: true, data: rowToApi(result.rows[0]) };
}

async function notifications(auth) {
  const rows = await pool.query(
    `SELECT * FROM hr_notifications
      WHERE (user_id = $1 OR role = $2 OR role IS NULL) AND read_at IS NULL
      ORDER BY created_at DESC LIMIT 20`,
    [auth.userId, auth.role]
  );
  return { data: rows.rows.map(rowToApi) };
}

async function passwordReset({ email }) {
  if (!email) throw new AppError(400, "Email is required");
  await audit({ email: "system" }, "Password reset requested", "authentication", email);
  return { ok: true, message: "If this HR account exists, reset instructions will be sent." };
}

async function upload(auth, payload = {}, meta = {}) {
  const normalizedPayload = normaliseHrPayload("uploads", payload, auth);
  const title = normalizedPayload.title || normalizedPayload.fileName || normalizedPayload.name || "HR document";
  const category = normalizedPayload.category || "General";
  const fileUrl = normalizedPayload.fileUrl || normalizedPayload.url || "private-hr-storage";
  const mimeType = normalizedPayload.mimeType || payload.mimeType || payload.contentType || null;
  const result = await pool.query(
    `INSERT INTO hr_employee_documents
       (employee_id, title, category, file_url, mime_type, uploaded_by, requires_signature, status, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', $8)
     RETURNING *`,
    [
      payload.employeeId || auth.employeeId || null,
      title,
      category,
      fileUrl,
      mimeType,
      auth.userId || null,
      Boolean(normalizedPayload.requiresSignature),
      {
        originalName: payload.fileName || payload.name || title,
        source: "hr-portal"
      }
    ]
  );
  await audit(auth, "Uploaded file", "documents", title, meta);
  return { ok: true, data: rowToApi(result.rows[0]), fileName: title, private: true, storage: "private-hr-storage" };
}

async function exportResource(resourceName, kind, auth) {
  const config = assertResource(resourceName);
  assertPermission(auth, config, "read");
  const result = await list(resourceName, auth, { limit: 500, offset: 0 });
  const rows = result.data;
  if (kind === "csv") {
    const headers = [...new Set(rows.flatMap((row) => Object.keys(row)))];
    const csv = [headers.join(","), ...rows.map((row) => headers.map((key) => `"${String(row[key] ?? "").replace(/"/g, '""')}"`).join(","))].join("\n");
    return { contentType: "text/csv", body: csv || "No records yet\n" };
  }
  return {
    contentType: "application/pdf",
    body: resourceName === "attendance"
      ? attendancePdf(rows, auth)
      : simplePdf(`TitoPay HR ${resourceName} export`, rows)
  };
}

function attendancePdf(rows, auth) {
  const safe = (value, max = 18) => String(value ?? "—").replace(/[()\\]/g, "").slice(0, max);
  const dates = rows.map((row) => String(row.workDate || "").slice(0, 10)).filter(Boolean).sort();
  const range = dates.length ? `${dates[0]} to ${dates[dates.length - 1]}` : "No attendance dates";
  const columns = [
    ["Date", 36, 58, (row) => safe(row.workDate, 10)],
    ["Employee", 96, 98, (row) => safe(row.employee, 18)],
    ["Clock in", 198, 54, (row) => safe(row.clockIn, 8)],
    ["Clock out", 254, 56, (row) => safe(row.clockOut, 8)],
    ["Break", 312, 42, (row) => safe(row.breakMinutes, 5)],
    ["Hours", 356, 42, (row) => safe(((Number(row.regularMinutes || 0) + Number(row.overtimeMinutes || 0)) / 60).toFixed(2), 6)],
    ["OT", 400, 38, (row) => safe((Number(row.overtimeMinutes || 0) / 60).toFixed(2), 5)],
    ["Late", 440, 38, (row) => safe(row.minutesLate, 5)],
    ["Status", 480, 70, (row) => safe(row.status, 11)]
  ];
  const pageSize = 27;
  const pages = Array.from({ length: Math.max(1, Math.ceil(rows.length / pageSize)) }, (_, index) => rows.slice(index * pageSize, (index + 1) * pageSize));
  const streams = pages.map((pageRows, pageIndex) => {
    const commands = [
      "BT /F1 16 Tf 36 806 Td (TitoPay HR) Tj ET",
      "BT /F1 12 Tf 36 786 Td (Attendance Report) Tj ET",
      `BT /F1 8 Tf 36 768 Td (Date range: ${safe(range, 60)}) Tj ET`,
      `BT /F1 8 Tf 36 754 Td (Generated: ${safe(new Date().toISOString(), 30)}  By: ${safe(auth?.name || auth?.email || "HR", 35)}) Tj ET`,
      "0.85 G 36 738 m 550 738 l S",
      ...columns.map(([label, x]) => `BT /F1 7 Tf ${x} 723 Td (${label}) Tj ET`),
      "0.75 G 36 715 m 550 715 l S"
    ];
    pageRows.forEach((row, rowIndex) => {
      const y = 698 - rowIndex * 23;
      commands.push(...columns.map(([, x, , render]) => `BT /F1 7 Tf ${x} ${y} Td (${render(row)}) Tj ET`));
      commands.push(`0.92 G 36 ${y - 8} m 550 ${y - 8} l S`);
    });
    commands.push(`BT /F1 8 Tf 485 28 Td (Page ${pageIndex + 1} of ${pages.length}) Tj ET`);
    return commands.join("\n");
  });
  return buildPdfPages(streams);
}

function buildPdfPages(streams) {
  const pageObjectIds = streams.map((_, index) => 4 + index * 2);
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${streams.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
  ];
  streams.forEach((stream, index) => {
    const pageId = 4 + index * 2;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageId + 1} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(stream)} >> stream\n${stream}\nendstream`);
  });
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n `).join("\n")}\n`;
  pdf += `trailer << /Root 1 0 R /Size ${objects.length + 1} >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf, "utf8");
}

function simplePdf(title, rows) {
  const escapePdf = (value) => String(value ?? "").replace(/[()\\]/g, "");
  const lines = [
    title,
    `Generated ${new Date().toISOString()}`,
    "",
    ...(rows.length
      ? rows.slice(0, 38).map((row) => Object.entries(row).slice(0, 6).map(([key, value]) => `${key}: ${value ?? ""}`).join(" | "))
      : ["No records yet"])
  ];
  const content = lines.map((line, index) => `BT /F1 9 Tf 36 ${790 - index * 17} Td (${escapePdf(line).slice(0, 120)}) Tj ET`).join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(content)} >> stream\n${content}\nendstream`
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n `).join("\n")}\n`;
  pdf += `trailer << /Root 1 0 R /Size ${objects.length + 1} >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf, "utf8");
}

module.exports = {
  resources,
  hashPassword,
  health,
  login,
  refresh,
  logout,
  dashboard,
  learningDashboard,
  list,
  create,
  update,
  remove,
  enrolLearning,
  updateLearningProgress,
  issueLearningCertificate,
  toggleLearningBookmark,
  leaveDecision,
  clock,
  receiveWebsiteApplication,
  notifications,
  passwordReset,
  upload,
  exportResource
};
