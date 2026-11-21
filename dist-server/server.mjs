// server.ts
import "dotenv/config";
import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import nodemailer from "nodemailer";
import {
  applicationDefault,
  cert,
  getApp,
  getApps,
  initializeApp
} from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import {
  FieldValue,
  getFirestore
} from "firebase-admin/firestore";

// src/server/bootstrap-service.ts
import crypto2 from "crypto";

// src/server/firestore-types.ts
function isTransientFirestoreError(err) {
  if (!err || typeof err !== "object") return false;
  const code = err.code;
  if (code === 4 || code === 8 || code === 10 || code === 14) return true;
  if (typeof code === "string" && ["deadline-exceeded", "resource-exhausted", "aborted", "unavailable"].includes(
    code.toLowerCase()
  )) {
    return true;
  }
  const msg = err instanceof Error ? err.message.toLowerCase() : "";
  return msg.includes("deadline exceeded") || msg.includes("unavailable") || msg.includes("aborted") || msg.includes("try again");
}
async function withTransientRetry(operation, options) {
  const maxAttempts = options?.maxAttempts ?? 3;
  const baseDelayMs = options?.baseDelayMs ?? 150;
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (err) {
      lastError = err;
      if (attempt >= maxAttempts || !isTransientFirestoreError(err)) {
        throw err;
      }
      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}
function timestampValueToMillis(value) {
  if (!value) return null;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "object" && value !== null) {
    const maybe = value;
    if (typeof maybe.toMillis === "function") {
      return maybe.toMillis();
    }
    const secs = typeof maybe.seconds === "number" ? maybe.seconds : typeof maybe._seconds === "number" ? maybe._seconds : null;
    if (secs !== null) {
      return secs * 1e3;
    }
  }
  if (typeof value === "string") {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

// src/server/logger.ts
function emitStructuredLog(level, component, event, details) {
  const payload = {
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    level,
    component,
    event,
    ...details || {}
  };
  const line = JSON.stringify(payload);
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

// src/server/notification-guard.ts
import crypto from "crypto";

// src/lib/domain/dates.ts
function parseIsoDateParts(isoDate) {
  const clean = isoDate.slice(0, 10);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(clean);
  if (!match) {
    throw new Error(`Invalid ISO date format: ${isoDate}. Expected YYYY-MM-DD.`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    throw new Error(`Invalid calendar date: ${isoDate}`);
  }
  return { year, month, day };
}
function formatIsoDateParts(year, month, day) {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
function addDaysSafe(isoDate, days) {
  const { year, month, day } = parseIsoDateParts(isoDate);
  const dt = new Date(Date.UTC(year, month - 1, day + days));
  return formatIsoDateParts(
    dt.getUTCFullYear(),
    dt.getUTCMonth() + 1,
    dt.getUTCDate()
  );
}
function diffDays(fromIso, toIso) {
  const a = parseIsoDateParts(fromIso);
  const b = parseIsoDateParts(toIso);
  const utcA = Date.UTC(a.year, a.month - 1, a.day);
  const utcB = Date.UTC(b.year, b.month - 1, b.day);
  return Math.round((utcB - utcA) / (1e3 * 60 * 60 * 24));
}

// src/lib/domain/subscription.ts
function computeEffectiveAccessEndIso(subscriptionEndAtIso, gracePeriodDays) {
  const safeEnd = (subscriptionEndAtIso || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(safeEnd)) {
    return "";
  }
  return addDaysSafe(safeEnd, Math.max(0, Number(gracePeriodDays) || 0));
}
function evaluateGymSubscriptionAccess(gym, todayIso) {
  const endIso = (gym.subscriptionEndAt || "").slice(0, 10);
  const graceDays = Math.max(0, Number(gym.gracePeriodDays) || 0);
  const effectiveAccessUntil = computeEffectiveAccessEndIso(endIso, graceDays);
  const daysUntilExpiry = /^\d{4}-\d{2}-\d{2}$/.test(endIso) ? diffDays(todayIso, endIso) : null;
  if (gym.accountStatus === "SUSPENDED" /* SUSPENDED */) {
    return {
      isLocked: true,
      reason: "SUSPENDED",
      effectiveAccessUntil,
      daysUntilExpiry,
      inGracePeriod: false
    };
  }
  if (gym.subscriptionStatus === "PENDING" /* PENDING */) {
    return {
      isLocked: true,
      reason: "PENDING_VERIFICATION",
      effectiveAccessUntil,
      daysUntilExpiry,
      inGracePeriod: false
    };
  }
  if (gym.subscriptionStatus === "CANCELLED" /* CANCELLED */) {
    return {
      isLocked: true,
      reason: "CANCELLED",
      effectiveAccessUntil,
      daysUntilExpiry,
      inGracePeriod: false
    };
  }
  if (gym.subscriptionStatus === "EXPIRED" /* EXPIRED */) {
    return {
      isLocked: true,
      reason: "EXPIRED",
      effectiveAccessUntil,
      daysUntilExpiry,
      inGracePeriod: false
    };
  }
  if (!effectiveAccessUntil || todayIso > effectiveAccessUntil) {
    return {
      isLocked: true,
      reason: "EXPIRED",
      effectiveAccessUntil,
      daysUntilExpiry,
      inGracePeriod: false
    };
  }
  const inGracePeriod = Boolean(
    daysUntilExpiry !== null && daysUntilExpiry < 0 && effectiveAccessUntil && todayIso <= effectiveAccessUntil
  );
  return {
    isLocked: false,
    reason: "ACTIVE",
    effectiveAccessUntil,
    daysUntilExpiry,
    inGracePeriod
  };
}

// src/server/notification-guard.ts
var HttpError = class extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
};
var VALID_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;
var USER_RATE_LIMIT = { limit: 25, windowMs: 10 * 6e4 };
var GYM_RATE_LIMIT = { limit: 100, windowMs: 10 * 6e4 };
async function writeSecurityAuditLog(db, serverTimestamp, entry) {
  try {
    const id = `aud_${crypto.randomBytes(8).toString("hex")}`;
    await db.collection("audit_logs").doc(id).set({
      id,
      actorUid: entry.actorUid,
      actorEmail: entry.actorEmail || "unknown@gymos.local",
      actorRole: entry.actorRole || "UNKNOWN",
      ...entry.gymId ? { gymId: entry.gymId } : {},
      action: entry.action.slice(0, 80),
      entityType: entry.entityType.slice(0, 64),
      entityId: entry.entityId.slice(0, 128),
      summary: entry.summary.slice(0, 300),
      createdAt: serverTimestamp()
    });
  } catch (err) {
    emitStructuredLog("warn", "notification-guard", "audit_log_write_failed", {
      action: entry.action,
      error: err instanceof Error ? err.message : String(err)
    });
  }
}
async function authorizeAndResolveNotificationDispatch(params) {
  const { db, rateLimiter: rateLimiter2, actor, body, serverTimestamp } = params;
  const nowMs = params.nowMs ?? Date.now();
  const todayIso = new Date(nowMs).toISOString().slice(0, 10);
  if (!db) {
    throw new HttpError(
      503,
      "ADMIN_DB_UNAVAILABLE",
      "Notification authorization requires server-side Firestore credentials."
    );
  }
  const gymId = typeof body.gymId === "string" ? body.gymId.trim() : "";
  const channel = typeof body.channel === "string" ? body.channel.trim() : "";
  const rawMessage = typeof body.message === "string" ? body.message.trim() : "";
  const rawSubject = typeof body.subject === "string" ? body.subject.replace(/[\r\n]+/g, " ").trim() : "GymOS Reminder";
  const memberId = typeof body.memberId === "string" ? body.memberId.trim() : "";
  const rawTargetType = typeof body.targetType === "string" ? body.targetType.trim() : "";
  if (!VALID_ID_RE.test(gymId)) {
    throw new HttpError(400, "INVALID_GYM_ID", "Valid gymId is required.");
  }
  if (channel !== "EMAIL" && channel !== "WHATSAPP_CLOUD") {
    throw new HttpError(
      400,
      "UNSUPPORTED_CHANNEL",
      `Unsupported delivery channel "${channel}".`
    );
  }
  if (!rawMessage || rawMessage.length > 1e3) {
    throw new HttpError(
      400,
      "INVALID_MESSAGE",
      "Message body is required and must be 1000 characters or fewer."
    );
  }
  const targetType = rawTargetType === "OWNER_SUBSCRIPTION" || memberId === `owner_${gymId}` ? "OWNER_SUBSCRIPTION" : "MEMBER";
  if (targetType === "MEMBER" && !VALID_ID_RE.test(memberId)) {
    throw new HttpError(
      400,
      "INVALID_MEMBER_ID",
      "Valid memberId (or OWNER_SUBSCRIPTION targetType) is required."
    );
  }
  const userLimit = rateLimiter2.consume(
    `notif:user:${actor.uid}`,
    USER_RATE_LIMIT.limit,
    USER_RATE_LIMIT.windowMs,
    nowMs
  );
  if (!userLimit.allowed) {
    await writeSecurityAuditLog(db, serverTimestamp, {
      actorUid: actor.uid,
      actorEmail: actor.email,
      actorRole: "USER",
      gymId,
      action: "NOTIFICATION_RATE_LIMITED",
      entityType: "Notification",
      entityId: actor.uid,
      summary: `Per-user notification rate limit exceeded for ${actor.email}`
    });
    throw new HttpError(
      429,
      "USER_RATE_LIMITED",
      `Rate limit exceeded. Retry after ${userLimit.retryAfterSeconds}s.`
    );
  }
  const gymLimit = rateLimiter2.consume(
    `notif:gym:${gymId}`,
    GYM_RATE_LIMIT.limit,
    GYM_RATE_LIMIT.windowMs,
    nowMs
  );
  if (!gymLimit.allowed) {
    await writeSecurityAuditLog(db, serverTimestamp, {
      actorUid: actor.uid,
      actorEmail: actor.email,
      actorRole: "USER",
      gymId,
      action: "NOTIFICATION_GYM_RATE_LIMITED",
      entityType: "Gym",
      entityId: gymId,
      summary: `Per-gym notification rate limit exceeded for gym ${gymId}`
    });
    throw new HttpError(
      429,
      "GYM_RATE_LIMITED",
      `Gym notification quota exceeded. Retry after ${gymLimit.retryAfterSeconds}s.`
    );
  }
  const userSnap = await withTransientRetry(
    () => db.collection("users").doc(actor.uid).get()
  );
  if (!userSnap.exists) {
    await writeSecurityAuditLog(db, serverTimestamp, {
      actorUid: actor.uid,
      actorEmail: actor.email,
      actorRole: "UNREGISTERED",
      gymId,
      action: "NOTIFICATION_SEND_DENIED",
      entityType: "Gym",
      entityId: gymId,
      summary: `Rejected notification attempt by unregistered account ${actor.email}`
    });
    throw new HttpError(403, "PROFILE_NOT_FOUND", "Active GymOS profile is required.");
  }
  const user = userSnap.data() || {};
  const userRole = String(user.role || "");
  const userStatus = String(user.status || "");
  const userGymId = String(user.gymId || "");
  if (userStatus !== "ACTIVE") {
    await writeSecurityAuditLog(db, serverTimestamp, {
      actorUid: actor.uid,
      actorEmail: actor.email,
      actorRole: userRole || "UNKNOWN",
      gymId,
      action: "NOTIFICATION_SEND_DENIED",
      entityType: "User",
      entityId: actor.uid,
      summary: `Rejected notification attempt by deactivated account ${actor.email}`
    });
    throw new HttpError(403, "ACCOUNT_DEACTIVATED", "Your GymOS account is deactivated.");
  }
  let authorized = false;
  if (userRole === "SUPER_ADMIN") {
    const adminSnap = await withTransientRetry(
      () => db.collection("platform_admins").doc(actor.uid).get()
    );
    authorized = adminSnap.exists;
  } else if (userGymId === gymId) {
    if (userRole === "GYM_OWNER") {
      authorized = true;
    } else if (["GYM_MANAGER", "GYM_RECEPTIONIST", "GYM_TRAINER"].includes(userRole)) {
      const staffSnap = await withTransientRetry(
        () => db.collection("gyms").doc(gymId).collection("staff").doc(actor.uid).get()
      );
      if (staffSnap.exists) {
        const staff = staffSnap.data() || {};
        const perms = staff.permissions || {};
        if (staff.status === "ACTIVE" && perms.canManageReminders === true) {
          authorized = true;
        }
      }
    }
  }
  if (!authorized) {
    await writeSecurityAuditLog(db, serverTimestamp, {
      actorUid: actor.uid,
      actorEmail: actor.email,
      actorRole: userRole || "UNKNOWN",
      gymId,
      action: "NOTIFICATION_SEND_DENIED",
      entityType: "Gym",
      entityId: gymId,
      summary: `Unauthorized notification attempt for gym ${gymId} by ${actor.email} (${userRole})`
    });
    throw new HttpError(
      403,
      "FORBIDDEN_NOTIFICATION_ROLE",
      "You are not authorized to send reminders for this gym."
    );
  }
  const gymRef = db.collection("gyms").doc(gymId);
  const [gymSnap, settingsSnap] = await withTransientRetry(
    () => Promise.all([gymRef.get(), gymRef.collection("settings").doc("default").get()])
  );
  if (!gymSnap.exists) {
    throw new HttpError(404, "GYM_NOT_FOUND", "Authorized gym record not found.");
  }
  const gymData = gymSnap.data() || {};
  const gymName = String(gymData.name || "GymOS");
  const accessState = evaluateGymSubscriptionAccess(
    {
      accountStatus: gymData.accountStatus || "SUSPENDED" /* SUSPENDED */,
      subscriptionStatus: gymData.subscriptionStatus || "EXPIRED" /* EXPIRED */,
      subscriptionEndAt: String(gymData.subscriptionEndAt || ""),
      gracePeriodDays: Number(gymData.gracePeriodDays || 0)
    },
    todayIso
  );
  const accessUntilMs = timestampValueToMillis(gymData.subscriptionAccessUntil);
  const accessTimestampMissingOrExpired = accessUntilMs === null || accessUntilMs <= nowMs;
  if (accessState.isLocked || accessTimestampMissingOrExpired) {
    await writeSecurityAuditLog(db, serverTimestamp, {
      actorUid: actor.uid,
      actorEmail: actor.email,
      actorRole: userRole,
      gymId,
      action: "NOTIFICATION_GYM_INACTIVE",
      entityType: "Gym",
      entityId: gymId,
      summary: `Blocked notification dispatch for inactive/expired gym ${gymId} (${accessState.reason})`
    });
    throw new HttpError(
      403,
      "GYM_INACTIVE",
      "Notifications are blocked while gym account or subscription is inactive."
    );
  }
  const settingsData = settingsSnap.exists ? settingsSnap.data() || {} : {};
  const emailEnabled = settingsData.emailEnabled !== false;
  const emailFromName = String(settingsData.emailFromName || gymName || "GymOS").replace(/["<>]/g, "").trim().slice(0, 120);
  const whatsappEnabled = Boolean(settingsData.whatsappEnabled);
  const whatsappPhoneNumberId = String(settingsData.whatsappPhoneNumberId || "").trim();
  const whatsappApprovedTemplate = String(
    settingsData.whatsappApprovedTemplate || ""
  ).trim();
  if (typeof body.whatsappPhoneNumberId === "string" && body.whatsappPhoneNumberId.trim() && body.whatsappPhoneNumberId.trim() !== whatsappPhoneNumberId) {
    await writeSecurityAuditLog(db, serverTimestamp, {
      actorUid: actor.uid,
      actorEmail: actor.email,
      actorRole: userRole,
      gymId,
      action: "NOTIFICATION_CONFIG_TAMPER",
      entityType: "GymSettings",
      entityId: gymId,
      summary: `Rejected mismatched WhatsApp Phone Number ID supplied by ${actor.email}`
    });
    throw new HttpError(
      403,
      "CONFIG_MISMATCH",
      "WhatsApp Phone Number ID must match saved gym configuration."
    );
  }
  if (channel === "EMAIL" && !emailEnabled) {
    throw new HttpError(
      400,
      "EMAIL_DISABLED",
      "Email notifications are disabled in this gym settings."
    );
  }
  if (channel === "WHATSAPP_CLOUD") {
    if (!whatsappEnabled || !whatsappPhoneNumberId || !whatsappApprovedTemplate) {
      throw new HttpError(
        400,
        "WHATSAPP_NOT_CONFIGURED",
        "WhatsApp Cloud API is not enabled or configured in this gym settings."
      );
    }
  }
  let trustedRecipient = "";
  let resolvedMemberId = memberId || `owner_${gymId}`;
  if (targetType === "OWNER_SUBSCRIPTION") {
    if (channel !== "EMAIL") {
      throw new HttpError(
        400,
        "INVALID_OWNER_CHANNEL",
        "Owner subscription reminders support EMAIL channel only."
      );
    }
    trustedRecipient = String(gymData.email || "").trim();
    resolvedMemberId = `owner_${gymId}`;
    if (!trustedRecipient) {
      throw new HttpError(
        400,
        "MISSING_OWNER_EMAIL",
        "Gym owner email address is missing."
      );
    }
  } else {
    const memberSnap = await withTransientRetry(
      () => gymRef.collection("members").doc(memberId).get()
    );
    if (!memberSnap.exists) {
      await writeSecurityAuditLog(db, serverTimestamp, {
        actorUid: actor.uid,
        actorEmail: actor.email,
        actorRole: userRole,
        gymId,
        action: "NOTIFICATION_INVALID_RECIPIENT",
        entityType: "Member",
        entityId: memberId,
        summary: `Rejected notification for non-existent member ${memberId} in gym ${gymId}`
      });
      throw new HttpError(
        404,
        "MEMBER_NOT_FOUND",
        "Recipient member does not belong to the authorized gym."
      );
    }
    const member = memberSnap.data() || {};
    if (String(member.gymId || "") !== gymId || member.isArchived === true) {
      throw new HttpError(
        403,
        "INVALID_MEMBER_STATE",
        "Recipient member is archived or does not belong to this gym."
      );
    }
    if (member.reminderOptOut === true) {
      throw new HttpError(
        400,
        "MEMBER_OPTED_OUT",
        "Member has opted out of automated reminders."
      );
    }
    trustedRecipient = channel === "EMAIL" ? String(member.email || "").trim() : String(member.phone || "").trim();
    if (!trustedRecipient) {
      throw new HttpError(
        400,
        "MISSING_MEMBER_CONTACT",
        `Member does not have a valid ${channel === "EMAIL" ? "email address" : "phone number"}.`
      );
    }
  }
  if (typeof body.recipient === "string" && body.recipient.trim()) {
    const supplied = body.recipient.trim();
    const mismatch = channel === "EMAIL" ? supplied.toLowerCase() !== trustedRecipient.toLowerCase() : supplied.replace(/\D/g, "") !== trustedRecipient.replace(/\D/g, "");
    if (mismatch) {
      await writeSecurityAuditLog(db, serverTimestamp, {
        actorUid: actor.uid,
        actorEmail: actor.email,
        actorRole: userRole,
        gymId,
        action: "NOTIFICATION_RECIPIENT_MISMATCH",
        entityType: "Member",
        entityId: resolvedMemberId,
        summary: `Rejected notification with spoofed recipient for member ${resolvedMemberId}`
      });
      throw new HttpError(
        403,
        "RECIPIENT_MISMATCH",
        "Recipient does not match the authorized gym member record."
      );
    }
  }
  const templateParams = Array.isArray(body.whatsappTemplateParams) ? body.whatsappTemplateParams.slice(0, 6).map((p) => String(p).slice(0, 200)) : void 0;
  await writeSecurityAuditLog(db, serverTimestamp, {
    actorUid: actor.uid,
    actorEmail: actor.email,
    actorRole: userRole,
    gymId,
    action: "SEND_NOTIFICATION",
    entityType: "Member",
    entityId: resolvedMemberId,
    summary: `Authorized ${channel} notification dispatch for ${resolvedMemberId}`
  });
  emitStructuredLog("info", "notification-guard", "notification_authorized", {
    gymId,
    actorUid: actor.uid,
    actorRole: userRole,
    channel,
    targetType,
    memberId: resolvedMemberId
  });
  return {
    gymId,
    gymName,
    memberId: resolvedMemberId,
    targetType,
    channel,
    recipient: trustedRecipient,
    subject: rawSubject.slice(0, 180) || `${gymName} Reminder`,
    message: rawMessage,
    fromName: emailFromName || gymName || "GymOS",
    whatsappPhoneNumberId: channel === "WHATSAPP_CLOUD" ? whatsappPhoneNumberId : void 0,
    whatsappApprovedTemplate: channel === "WHATSAPP_CLOUD" ? whatsappApprovedTemplate : void 0,
    whatsappTemplateParams: templateParams
  };
}

// src/server/bootstrap-service.ts
var BOOTSTRAP_DOC_COLLECTION = "platform_bootstrap";
var BOOTSTRAP_DOC_ID = "default";
var BOOTSTRAP_RATE_LIMIT = { limit: 5, windowMs: 15 * 6e4 };
function timingSafeMatch(a, b) {
  if (!a || !b) return false;
  const digestA = crypto2.createHash("sha256").update(a).digest();
  const digestB = crypto2.createHash("sha256").update(b).digest();
  return crypto2.timingSafeEqual(digestA, digestB);
}
async function recordBootstrapAudit(db, serverTimestamp, entry) {
  try {
    const id = `aud_${crypto2.randomBytes(8).toString("hex")}`;
    await db.collection("audit_logs").doc(id).set({
      id,
      actorUid: entry.actorUid,
      actorEmail: entry.actorEmail || "unknown@gymos.local",
      actorRole: entry.actorRole,
      action: entry.action,
      entityType: "PlatformBootstrap",
      entityId: BOOTSTRAP_DOC_ID,
      summary: entry.summary.slice(0, 300),
      createdAt: serverTimestamp()
    });
  } catch (err) {
    emitStructuredLog("warn", "bootstrap-service", "audit_write_failed", {
      action: entry.action,
      error: err instanceof Error ? err.message : String(err)
    });
  }
}
var BootstrapController = class {
  constructor() {
    this.completed = false;
    this.inFlight = false;
  }
  get isCompleted() {
    return this.completed;
  }
  isWebBootstrapEnabled(configuredToken, configuredEmail) {
    return !this.completed && Boolean(configuredToken.trim() && configuredEmail.trim());
  }
  async syncFromDatabase(db) {
    if (!db) return this.completed;
    try {
      const [lockSnap, adminSnap] = await withTransientRetry(
        () => Promise.all([
          db.collection(BOOTSTRAP_DOC_COLLECTION).doc(BOOTSTRAP_DOC_ID).get(),
          db.collection("platform_admins").limit(1).get()
        ])
      );
      if (lockSnap.exists && lockSnap.data()?.completed === true || !adminSnap.empty) {
        this.completed = true;
      }
    } catch (err) {
      emitStructuredLog("warn", "bootstrap-service", "sync_state_failed", {
        error: err instanceof Error ? err.message : String(err)
      });
    }
    return this.completed;
  }
  async executeWebBootstrap(params) {
    const {
      db,
      rateLimiter: rateLimiter2,
      clientIp,
      actor,
      displayName,
      bootstrapToken,
      configuredToken,
      configuredEmail,
      serverTimestamp,
      onSuccessInvalidateSecrets
    } = params;
    const nowMs = params.nowMs ?? Date.now();
    const ipLimit = rateLimiter2.consume(
      `bootstrap:ip:${clientIp || "unknown"}`,
      BOOTSTRAP_RATE_LIMIT.limit,
      BOOTSTRAP_RATE_LIMIT.windowMs,
      nowMs
    );
    const uidLimit = rateLimiter2.consume(
      `bootstrap:uid:${actor.uid}`,
      BOOTSTRAP_RATE_LIMIT.limit,
      BOOTSTRAP_RATE_LIMIT.windowMs,
      nowMs
    );
    if (!ipLimit.allowed || !uidLimit.allowed) {
      if (db) {
        await recordBootstrapAudit(db, serverTimestamp, {
          actorUid: actor.uid,
          actorEmail: actor.email,
          actorRole: "USER",
          action: "BOOTSTRAP_RATE_LIMITED",
          summary: `Rate-limited Super Admin bootstrap attempt from ${actor.email} (${clientIp})`
        });
      }
      throw new HttpError(
        429,
        "BOOTSTRAP_RATE_LIMITED",
        "Too many bootstrap attempts. Try again later."
      );
    }
    if (this.completed) {
      throw new HttpError(
        409,
        "BOOTSTRAP_ALREADY_COMPLETED",
        "Platform Super Admin is already initialized. An existing Super Admin must authorize additional administrators."
      );
    }
    if (!configuredToken.trim() || !configuredEmail.trim()) {
      throw new HttpError(
        403,
        "BOOTSTRAP_DISABLED",
        "Super Admin web bootstrap requires both SUPER_ADMIN_BOOTSTRAP_TOKEN and SUPER_ADMIN_BOOTSTRAP_EMAIL."
      );
    }
    if (!actor.email || !actor.emailVerified) {
      throw new HttpError(
        401,
        "EMAIL_VERIFICATION_REQUIRED",
        "Verified email authentication is required."
      );
    }
    if (!db) {
      throw new HttpError(
        503,
        "ADMIN_DB_UNAVAILABLE",
        "Server-side Firestore credentials are not configured."
      );
    }
    const callerEmail = actor.email.trim().toLowerCase();
    const allowlistedEmail = configuredEmail.trim().toLowerCase();
    const tokenValid = typeof bootstrapToken === "string" && timingSafeMatch(bootstrapToken.trim(), configuredToken.trim());
    const emailAllowed = timingSafeMatch(callerEmail, allowlistedEmail);
    if (!tokenValid || !emailAllowed) {
      await recordBootstrapAudit(db, serverTimestamp, {
        actorUid: actor.uid,
        actorEmail: callerEmail,
        actorRole: "USER",
        action: "BOOTSTRAP_ATTEMPT_DENIED",
        summary: `Rejected Super Admin bootstrap attempt for ${callerEmail} (tokenValid=${tokenValid}, emailAllowed=${emailAllowed})`
      });
      throw new HttpError(
        403,
        "BOOTSTRAP_UNAUTHORIZED",
        "Invalid bootstrap token or caller email is not allowlisted for initial Super Admin setup."
      );
    }
    if (this.inFlight) {
      throw new HttpError(
        409,
        "BOOTSTRAP_IN_PROGRESS",
        "Super Admin bootstrap is already in progress."
      );
    }
    this.inFlight = true;
    try {
      const resolvedName = (displayName || callerEmail.split("@")[0] || "Platform Admin").trim().slice(0, 120);
      await db.runTransaction(async (tx) => {
        const lockRef = db.collection(BOOTSTRAP_DOC_COLLECTION).doc(BOOTSTRAP_DOC_ID);
        const adminsQuery = db.collection("platform_admins").limit(1);
        const [lockSnap, adminsSnap] = await Promise.all([
          tx.get(lockRef),
          tx.get(adminsQuery)
        ]);
        if (lockSnap.exists && lockSnap.data()?.completed === true || !adminsSnap.empty) {
          throw new HttpError(
            409,
            "BOOTSTRAP_ALREADY_COMPLETED",
            "Platform Super Admin is already initialized. An existing Super Admin must authorize additional administrators."
          );
        }
        tx.set(lockRef, {
          id: BOOTSTRAP_DOC_ID,
          completed: true,
          adminUid: actor.uid,
          adminEmail: callerEmail,
          method: "WEB_BOOTSTRAP",
          completedAt: serverTimestamp()
        });
        tx.set(db.collection("platform_admins").doc(actor.uid), {
          uid: actor.uid,
          email: callerEmail,
          displayName: resolvedName,
          createdAt: serverTimestamp()
        });
        tx.set(
          db.collection("users").doc(actor.uid),
          {
            uid: actor.uid,
            email: callerEmail,
            displayName: resolvedName,
            role: "SUPER_ADMIN",
            status: "ACTIVE",
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp()
          },
          { merge: true }
        );
        const auditId = `aud_${crypto2.randomBytes(8).toString("hex")}`;
        tx.set(db.collection("audit_logs").doc(auditId), {
          id: auditId,
          actorUid: actor.uid,
          actorEmail: callerEmail,
          actorRole: "SUPER_ADMIN",
          action: "BOOTSTRAP_SUPER_ADMIN",
          entityType: "PlatformAdmin",
          entityId: actor.uid,
          summary: `Initialized initial platform Super Admin (${callerEmail}) via atomic one-time bootstrap`,
          createdAt: serverTimestamp()
        });
      });
      this.completed = true;
      onSuccessInvalidateSecrets();
      emitStructuredLog("info", "bootstrap-service", "bootstrap_completed", {
        uid: actor.uid,
        email: callerEmail
      });
      return { uid: actor.uid, email: callerEmail };
    } catch (err) {
      if (err instanceof HttpError && err.status === 409) {
        this.completed = true;
        onSuccessInvalidateSecrets();
      }
      throw err;
    } finally {
      this.inFlight = false;
    }
  }
};

// src/server/rate-limiter.ts
var SlidingWindowRateLimiter = class {
  constructor() {
    this.buckets = /* @__PURE__ */ new Map();
    this.opsSinceSweep = 0;
  }
  consume(key, limit, windowMs, nowMs = Date.now()) {
    const cutoff = nowMs - windowMs;
    const existing = this.buckets.get(key);
    const active = existing ? existing.filter((ts) => ts > cutoff) : [];
    if (active.length >= limit) {
      this.buckets.set(key, active);
      const oldest = active[0] ?? nowMs;
      const retryAfterMs = Math.max(1e3, oldest + windowMs - nowMs);
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.ceil(retryAfterMs / 1e3),
        count: active.length
      };
    }
    active.push(nowMs);
    this.buckets.set(key, active);
    this.opsSinceSweep += 1;
    if (this.opsSinceSweep >= 250 || this.buckets.size > 5e3) {
      this.sweepExpired(nowMs, windowMs);
    }
    return {
      allowed: true,
      remaining: Math.max(0, limit - active.length),
      retryAfterSeconds: 0,
      count: active.length
    };
  }
  sweepExpired(nowMs, windowMs) {
    this.opsSinceSweep = 0;
    const cutoff = nowMs - windowMs;
    for (const [k, timestamps] of this.buckets.entries()) {
      const fresh = timestamps.filter((ts) => ts > cutoff);
      if (fresh.length === 0) {
        this.buckets.delete(k);
      } else {
        this.buckets.set(k, fresh);
      }
    }
  }
};

// src/server/reminder-worker.ts
import crypto3 from "crypto";

// src/lib/domain/reminders.ts
var MAX_REMINDER_RETRIES = 3;
var RETRY_BACKOFF_MINUTES = [15, 60, 240];
function buildDedupKey(memberId, template, scheduledDate, channel) {
  return `${memberId}__${template}__${scheduledDate}__${channel}`;
}
function buildReminderLogId(dedupKey) {
  let h1 = 2166136261;
  let h2 = 2654435769;
  for (let i = 0; i < dedupKey.length; i++) {
    const c = dedupKey.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 16777619);
    h2 ^= c + (i & 255);
    h2 = Math.imul(h2, 2246822507);
  }
  const part1 = (h1 >>> 0).toString(16).padStart(8, "0");
  const part2 = (h2 >>> 0).toString(16).padStart(8, "0");
  return `nlog_${part1}${part2}`;
}
function computeRetryBackoffMinutes(retryAttemptIndex) {
  const idx = Math.min(
    Math.max(0, Math.floor(retryAttemptIndex)),
    RETRY_BACKOFF_MINUTES.length - 1
  );
  return RETRY_BACKOFF_MINUTES[idx];
}
function isRetryDue(log, nowIso) {
  if (log.deliveryStatus !== "RETRY_SCHEDULED" /* RETRY_SCHEDULED */) return false;
  if ((log.retryCount || 0) >= MAX_REMINDER_RETRIES) return false;
  if (!log.nextRetryAt) return true;
  const dueMs = Date.parse(log.nextRetryAt);
  const nowMs = Date.parse(nowIso);
  if (Number.isFinite(dueMs) && Number.isFinite(nowMs)) {
    return dueMs <= nowMs;
  }
  return log.nextRetryAt <= nowIso;
}
function isWhatsAppReady(settings) {
  return Boolean(
    settings.whatsappEnabled && settings.whatsappPhoneNumberId?.trim() && settings.whatsappApprovedTemplate?.trim()
  );
}
function getActiveChannels(settings) {
  const activeChannels = [];
  if (settings.inAppEnabled) activeChannels.push("IN_APP" /* IN_APP */);
  if (settings.emailEnabled) activeChannels.push("EMAIL" /* EMAIL */);
  if (isWhatsAppReady(settings)) activeChannels.push("WHATSAPP_CLOUD" /* WHATSAPP_CLOUD */);
  return activeChannels;
}
function evaluateDueReminders(members, settings, existingLogs, todayIso, options) {
  const existingDedupKeys = new Set(existingLogs.map((l) => l.dedupKey));
  const candidates = [];
  const activeChannels = getActiveChannels(settings);
  const currency = settings.currencySymbol || "\u20B9";
  const gymName = options?.gym?.name || settings.emailFromName || "Your Gym";
  for (const member of members) {
    if (member.isArchived || !member.membershipExpiryDate) continue;
    const daysToExpiry = diffDays(todayIso, member.membershipExpiryDate);
    let template = null;
    let subject = "";
    let message = "";
    if (daysToExpiry > 0 && settings.reminderDaysBefore.includes(daysToExpiry)) {
      template = `EXPIRING_IN_${daysToExpiry}_DAYS`;
      subject = `${gymName}: Your membership expires in ${daysToExpiry} day${daysToExpiry === 1 ? "" : "s"}`;
      message = `Hi ${member.fullName}, your ${member.currentPlanName || "gym"} membership expires on ${member.membershipExpiryDate} (in ${daysToExpiry} days). Renew at the desk to avoid interruption.`;
    } else if (daysToExpiry === 0 && settings.sendOnExpiryDay) {
      template = "EXPIRING_TODAY";
      subject = `${gymName}: Your membership expires today`;
      message = `Hi ${member.fullName}, your ${member.currentPlanName || "gym"} membership expires today (${member.membershipExpiryDate}). Please renew today to stay active.`;
    } else if (daysToExpiry < 0 && settings.sendAfterExpiryDays.includes(Math.abs(daysToExpiry))) {
      const overdue = Math.abs(daysToExpiry);
      template = `EXPIRED_${overdue}_DAYS_AGO`;
      subject = `${gymName}: Membership expired ${overdue} day${overdue === 1 ? "" : "s"} ago`;
      message = `Hi ${member.fullName}, your ${member.currentPlanName || "gym"} membership expired on ${member.membershipExpiryDate}. Visit us to renew your plan.`;
    }
    if (template) {
      for (const channel of activeChannels) {
        const recipient = channel === "EMAIL" /* EMAIL */ ? member.email?.trim() || "" : channel === "WHATSAPP_CLOUD" /* WHATSAPP_CLOUD */ ? member.phone : member.memberCode;
        if (channel === "EMAIL" /* EMAIL */ && !recipient) continue;
        if (channel === "WHATSAPP_CLOUD" /* WHATSAPP_CLOUD */ && !recipient.trim()) continue;
        const dedupKey = buildDedupKey(member.id, template, todayIso, channel);
        if (existingDedupKeys.has(dedupKey)) continue;
        candidates.push({
          memberId: member.id,
          memberName: member.fullName,
          recipient,
          channel,
          category: "MEMBERSHIP_EXPIRY" /* MEMBERSHIP_EXPIRY */,
          template,
          subject,
          message,
          dedupKey,
          scheduledDate: todayIso,
          skippedOptOut: member.reminderOptOut
        });
      }
    }
  }
  const paymentRemindersEnabled = settings.paymentRemindersEnabled ?? true;
  if (paymentRemindersEnabled) {
    const upcomingWindow = Math.max(0, settings.upcomingPaymentReminderDays ?? 3);
    const overdueDaysList = settings.overduePaymentReminderDays ?? [1, 3, 7, 14];
    const memberships = options?.memberships ?? [];
    for (const member of members) {
      if (member.isArchived || (Number(member.outstandingBalance) || 0) <= 0) continue;
      const outstanding = Number(member.outstandingBalance).toFixed(2);
      const activeDueMs = memberships.find(
        (ms) => ms.memberId === member.id && ms.status === "ACTIVE" /* ACTIVE */ && ms.balanceDue > 0 && ms.dueDate
      );
      let category = null;
      let template = null;
      let subject = "";
      let message = "";
      if (activeDueMs?.dueDate) {
        const daysToDue = diffDays(todayIso, activeDueMs.dueDate);
        if (daysToDue >= 0 && daysToDue <= upcomingWindow) {
          category = "UPCOMING_PAYMENT" /* UPCOMING_PAYMENT */;
          template = `PAYMENT_DUE_IN_${daysToDue}_DAYS`;
          subject = `${gymName}: Payment due reminder (${currency}${outstanding})`;
          message = `Hi ${member.fullName}, you have a balance of ${currency}${outstanding} due on ${activeDueMs.dueDate}. Pay via Cash or UPI at the front desk.`;
        } else if (daysToDue < 0 && overdueDaysList.includes(Math.abs(daysToDue))) {
          const daysPast = Math.abs(daysToDue);
          category = "OVERDUE_PAYMENT" /* OVERDUE_PAYMENT */;
          template = `PAYMENT_OVERDUE_${daysPast}_DAYS`;
          subject = `${gymName}: Overdue balance reminder (${currency}${outstanding})`;
          message = `Hi ${member.fullName}, your balance of ${currency}${outstanding} is overdue by ${daysPast} day${daysPast === 1 ? "" : "s"} (due ${activeDueMs.dueDate}). Kindly settle at your earliest convenience.`;
        }
      } else if (member.membershipExpiryDate && diffDays(todayIso, member.membershipExpiryDate) < 0 && overdueDaysList.includes(Math.abs(diffDays(todayIso, member.membershipExpiryDate)))) {
        const daysPast = Math.abs(diffDays(todayIso, member.membershipExpiryDate));
        category = "OVERDUE_PAYMENT" /* OVERDUE_PAYMENT */;
        template = `BALANCE_OVERDUE_${daysPast}_DAYS`;
        subject = `${gymName}: Pending balance of ${currency}${outstanding}`;
        message = `Hi ${member.fullName}, an outstanding balance of ${currency}${outstanding} remains on your account. Please clear it at the reception desk.`;
      }
      if (category && template) {
        for (const channel of activeChannels) {
          const recipient = channel === "EMAIL" /* EMAIL */ ? member.email?.trim() || "" : channel === "WHATSAPP_CLOUD" /* WHATSAPP_CLOUD */ ? member.phone : member.memberCode;
          if (channel === "EMAIL" /* EMAIL */ && !recipient) continue;
          if (channel === "WHATSAPP_CLOUD" /* WHATSAPP_CLOUD */ && !recipient.trim()) continue;
          const dedupKey = buildDedupKey(member.id, template, todayIso, channel);
          if (existingDedupKeys.has(dedupKey)) continue;
          candidates.push({
            memberId: member.id,
            memberName: member.fullName,
            recipient,
            channel,
            category,
            template,
            subject,
            message,
            dedupKey,
            scheduledDate: todayIso,
            skippedOptOut: member.reminderOptOut
          });
        }
      }
    }
  }
  if (options?.gym?.subscriptionEndAt) {
    const subEnd = options.gym.subscriptionEndAt.slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(subEnd)) {
      const daysLeft = diffDays(todayIso, subEnd);
      const ownerAlertDays = settings.ownerSubReminderDays ?? [7, 3, 1, 0, -3];
      if (ownerAlertDays.includes(daysLeft)) {
        const template = daysLeft > 0 ? `OWNER_SUB_EXPIRING_IN_${daysLeft}_DAYS` : daysLeft === 0 ? "OWNER_SUB_EXPIRING_TODAY" : `OWNER_SUB_EXPIRED_${Math.abs(daysLeft)}_DAYS_AGO`;
        const subject = `GymOS Subscription Alert for ${options.gym.name}`;
        const message = daysLeft > 0 ? `Your GymOS ${options.gym.subscriptionPlanName} subscription expires on ${subEnd} (${daysLeft} days left). Contact support to renew.` : daysLeft === 0 ? `Your GymOS ${options.gym.subscriptionPlanName} subscription expires today (${subEnd}). Please complete renewal to prevent lockout.` : `Your GymOS ${options.gym.subscriptionPlanName} subscription expired on ${subEnd}. Renew immediately to restore uninterrupted access.`;
        for (const channel of ["IN_APP" /* IN_APP */, "EMAIL" /* EMAIL */]) {
          if (channel === "EMAIL" /* EMAIL */ && !settings.emailEnabled) continue;
          const recipient = channel === "EMAIL" /* EMAIL */ ? options.gym.email : options.gym.ownerUid;
          if (!recipient) continue;
          const dedupKey = buildDedupKey(`owner_${options.gym.id}`, template, todayIso, channel);
          if (existingDedupKeys.has(dedupKey)) continue;
          candidates.push({
            memberId: `owner_${options.gym.id}`,
            memberName: `${options.gym.ownerName} (Owner)`,
            recipient,
            channel,
            category: "SUBSCRIPTION_EXPIRY" /* SUBSCRIPTION_EXPIRY */,
            template,
            subject,
            message,
            dedupKey,
            scheduledDate: todayIso,
            skippedOptOut: false
          });
        }
      }
    }
  }
  return candidates;
}
function computeNextRetryState(currentLog, deliverySucceeded, errorMessage, nowMs = Date.now()) {
  if (currentLog.deliveryStatus === "SENT" /* SENT */) {
    return {
      canRetry: false,
      nextRetryCount: currentLog.retryCount,
      nextStatus: "SENT" /* SENT */,
      nextRetryAt: ""
    };
  }
  const nextCount = currentLog.retryCount + 1;
  if (deliverySucceeded) {
    return {
      canRetry: false,
      nextRetryCount: nextCount,
      nextStatus: "SENT" /* SENT */,
      nextRetryAt: ""
    };
  }
  if (nextCount >= MAX_REMINDER_RETRIES) {
    return {
      canRetry: false,
      nextRetryCount: nextCount,
      nextStatus: "FAILED" /* FAILED */,
      nextRetryAt: "",
      errorDetails: errorMessage || "Maximum retries reached"
    };
  }
  const backoffMinutes = computeRetryBackoffMinutes(nextCount);
  const nextRetryAt = new Date(nowMs + backoffMinutes * 6e4).toISOString();
  return {
    canRetry: true,
    nextRetryCount: nextCount,
    nextStatus: "RETRY_SCHEDULED" /* RETRY_SCHEDULED */,
    nextRetryAt,
    errorDetails: errorMessage || "Delivery attempt failed; scheduled for retry"
  };
}

// src/server/reminder-worker.ts
var WORKER_LOCK_COLLECTION = "system_locks";
var WORKER_LOCK_DOC_ID = "reminder_worker";
var WORKER_LOCK_TTL_MS = 5 * 6e4;
var ITEM_CLAIM_TTL_MS = 3 * 6e4;
async function paginateCollection(collection, pageSize, orderByField, maxTotalDocs = 1e4) {
  const allDocs = [];
  let lastDoc = null;
  while (allDocs.length < maxTotalDocs) {
    let q = orderByField ? collection.orderBy(orderByField) : collection;
    q = q.limit(pageSize);
    if (lastDoc !== null) {
      q = q.startAfter(lastDoc);
    }
    const snap = await withTransientRetry(() => q.get());
    if (snap.empty) break;
    allDocs.push(...snap.docs);
    if (snap.docs.length < pageSize) break;
    lastDoc = snap.docs[snap.docs.length - 1];
  }
  return allDocs;
}
function normalizeGymSettings(gym, raw) {
  return {
    gymId: gym.id,
    gracePeriodDays: Number(raw?.gracePeriodDays ?? gym.gracePeriodDays ?? 7),
    renewalPolicy: raw?.renewalPolicy || gym.renewalPolicy || "EXTEND_FROM_EXPIRY" /* EXTEND_FROM_EXPIRY */,
    reminderDaysBefore: Array.isArray(raw?.reminderDaysBefore) ? raw?.reminderDaysBefore : [7, 3, 1],
    sendOnExpiryDay: raw?.sendOnExpiryDay !== false,
    sendAfterExpiryDays: Array.isArray(raw?.sendAfterExpiryDays) ? raw?.sendAfterExpiryDays : [3, 7],
    paymentRemindersEnabled: raw?.paymentRemindersEnabled !== false,
    upcomingPaymentReminderDays: Number(raw?.upcomingPaymentReminderDays ?? 3),
    overduePaymentReminderDays: Array.isArray(raw?.overduePaymentReminderDays) ? raw?.overduePaymentReminderDays : [1, 3, 7, 14],
    ownerSubReminderDays: Array.isArray(raw?.ownerSubReminderDays) ? raw?.ownerSubReminderDays : [7, 3, 1, 0, -3],
    lastReminderRunDate: typeof raw?.lastReminderRunDate === "string" ? raw.lastReminderRunDate : void 0,
    emailEnabled: raw?.emailEnabled !== false,
    emailFromName: typeof raw?.emailFromName === "string" ? raw.emailFromName : gym.name,
    inAppEnabled: raw?.inAppEnabled !== false,
    whatsappEnabled: Boolean(raw?.whatsappEnabled),
    whatsappPhoneNumberId: typeof raw?.whatsappPhoneNumberId === "string" ? raw.whatsappPhoneNumberId : void 0,
    whatsappApprovedTemplate: typeof raw?.whatsappApprovedTemplate === "string" ? raw.whatsappApprovedTemplate : void 0,
    currencySymbol: typeof raw?.currencySymbol === "string" ? raw.currencySymbol : "\u20B9",
    updatedAt: raw?.updatedAt ?? null
  };
}
var ReminderWorker = class {
  constructor(options) {
    this.timer = null;
    this.activePromise = null;
    this.stopped = false;
    this.totalRuns = 0;
    this.lastRunStartedAt = null;
    this.lastRunFinishedAt = null;
    this.lastRunStats = null;
    this.db = options.db;
    this.sendEmail = options.sendEmail;
    this.sendWhatsApp = options.sendWhatsApp;
    this.serverTimestamp = options.serverTimestamp;
    this.intervalMinutes = options.intervalMinutes;
    this.orderByField = options.orderByField || "id";
  }
  start() {
    if (!this.db || this.intervalMinutes <= 0 || this.timer) return;
    const intervalMs = Math.round(this.intervalMinutes * 6e4);
    this.timer = setInterval(() => {
      if (this.stopped) return;
      this.sweep().catch((err) => {
        emitStructuredLog("error", "reminder-worker", "scheduled_sweep_error", {
          error: err instanceof Error ? err.message : String(err)
        });
      });
    }, intervalMs);
    this.timer.unref?.();
    emitStructuredLog("info", "reminder-worker", "scheduler_started", {
      intervalMinutes: this.intervalMinutes
    });
  }
  async stop() {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.activePromise) {
      await this.activePromise.catch(() => void 0);
    }
    emitStructuredLog("info", "reminder-worker", "scheduler_stopped");
  }
  getStatus() {
    return {
      running: Boolean(this.activePromise),
      intervalMinutes: this.intervalMinutes,
      totalRuns: this.totalRuns,
      lastRunStartedAt: this.lastRunStartedAt,
      lastRunFinishedAt: this.lastRunFinishedAt,
      lastRunStats: this.lastRunStats
    };
  }
  async sweep(options) {
    if (this.activePromise) {
      return {
        skipped: true,
        reason: "A reminder sweep is already active in this process.",
        gymsProcessed: 0,
        gymsSkipped: 0,
        candidatesEvaluated: 0,
        newRemindersCreated: 0,
        retriesAttempted: 0,
        delivered: 0,
        skippedOptOut: 0,
        failed: 0,
        duplicatesPrevented: 0
      };
    }
    const promise = this.executeSweep(options?.nowMs ?? Date.now());
    this.activePromise = promise;
    try {
      return await promise;
    } finally {
      this.activePromise = null;
    }
  }
  async acquireDistributedLock(workerId, nowMs) {
    if (!this.db) return false;
    const lockRef = this.db.collection(WORKER_LOCK_COLLECTION).doc(WORKER_LOCK_DOC_ID);
    return withTransientRetry(
      () => this.db.runTransaction(async (tx) => {
        const snap = await tx.get(lockRef);
        const existing = snap.exists ? snap.data() : void 0;
        const expiresAtMs = Number(existing?.expiresAtMs || 0);
        const released = existing?.released === true;
        if (snap.exists && !released && expiresAtMs > nowMs) {
          return false;
        }
        tx.set(lockRef, {
          id: WORKER_LOCK_DOC_ID,
          workerId,
          released: false,
          acquiredAtMs: nowMs,
          expiresAtMs: nowMs + WORKER_LOCK_TTL_MS,
          updatedAt: this.serverTimestamp()
        });
        return true;
      })
    );
  }
  async releaseDistributedLock(workerId) {
    if (!this.db) return;
    try {
      const lockRef = this.db.collection(WORKER_LOCK_COLLECTION).doc(WORKER_LOCK_DOC_ID);
      await this.db.runTransaction(async (tx) => {
        const snap = await tx.get(lockRef);
        if (!snap.exists) return;
        if (snap.data()?.workerId === workerId) {
          tx.set(lockRef, {
            id: WORKER_LOCK_DOC_ID,
            workerId,
            released: true,
            expiresAtMs: 0,
            updatedAt: this.serverTimestamp()
          });
        }
      });
    } catch (err) {
      emitStructuredLog("warn", "reminder-worker", "lock_release_failed", {
        workerId,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }
  async claimCandidateSlot(gymId, logId, workerId, nowMs) {
    if (!this.db) return false;
    const logRef = this.db.collection("gyms").doc(gymId).collection("notification_logs").doc(logId);
    const claimId = `claim_${gymId}_${logId}`.slice(0, 128);
    const claimRef = this.db.collection(WORKER_LOCK_COLLECTION).doc(claimId);
    return withTransientRetry(
      () => this.db.runTransaction(async (tx) => {
        const [logSnap, claimSnap] = await Promise.all([
          tx.get(logRef),
          tx.get(claimRef)
        ]);
        if (logSnap.exists) return false;
        const claimData = claimSnap.exists ? claimSnap.data() : void 0;
        if (claimSnap.exists && claimData?.released !== true && Number(claimData?.expiresAtMs || 0) > nowMs) {
          return false;
        }
        tx.set(claimRef, {
          id: claimId,
          workerId,
          released: false,
          expiresAtMs: nowMs + ITEM_CLAIM_TTL_MS,
          updatedAt: this.serverTimestamp()
        });
        return true;
      })
    );
  }
  async claimRetrySlot(gymId, logId, workerId, nowMs, nowIso) {
    if (!this.db) return null;
    const logRef = this.db.collection("gyms").doc(gymId).collection("notification_logs").doc(logId);
    const claimId = `retry_${gymId}_${logId}`.slice(0, 128);
    const claimRef = this.db.collection(WORKER_LOCK_COLLECTION).doc(claimId);
    return withTransientRetry(
      () => this.db.runTransaction(async (tx) => {
        const [logSnap, claimSnap] = await Promise.all([
          tx.get(logRef),
          tx.get(claimRef)
        ]);
        if (!logSnap.exists) return null;
        const freshLog = logSnap.data();
        if (!isRetryDue(freshLog, nowIso)) return null;
        const claimData = claimSnap.exists ? claimSnap.data() : void 0;
        if (claimSnap.exists && claimData?.released !== true && Number(claimData?.expiresAtMs || 0) > nowMs) {
          return null;
        }
        tx.set(claimRef, {
          id: claimId,
          workerId,
          released: false,
          expiresAtMs: nowMs + ITEM_CLAIM_TTL_MS,
          updatedAt: this.serverTimestamp()
        });
        return freshLog;
      })
    );
  }
  async releaseItemLock(claimId, workerId) {
    if (!this.db) return;
    try {
      await this.db.collection(WORKER_LOCK_COLLECTION).doc(claimId.slice(0, 128)).set({
        id: claimId.slice(0, 128),
        workerId,
        released: true,
        expiresAtMs: 0,
        updatedAt: this.serverTimestamp()
      });
    } catch {
    }
  }
  async executeSweep(nowMs) {
    if (!this.db) {
      return {
        skipped: true,
        reason: "Firebase Admin Firestore credentials (FIREBASE_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS) are not configured.",
        gymsProcessed: 0,
        gymsSkipped: 0,
        candidatesEvaluated: 0,
        newRemindersCreated: 0,
        retriesAttempted: 0,
        delivered: 0,
        skippedOptOut: 0,
        failed: 0,
        duplicatesPrevented: 0
      };
    }
    const workerId = `wrk_${crypto3.randomBytes(6).toString("hex")}`;
    const locked = await this.acquireDistributedLock(workerId, nowMs);
    if (!locked) {
      return {
        skipped: true,
        reason: "Another worker currently holds the reminder_worker execution lease.",
        gymsProcessed: 0,
        gymsSkipped: 0,
        candidatesEvaluated: 0,
        newRemindersCreated: 0,
        retriesAttempted: 0,
        delivered: 0,
        skippedOptOut: 0,
        failed: 0,
        duplicatesPrevented: 0
      };
    }
    const nowIso = new Date(nowMs).toISOString();
    const todayIso = nowIso.slice(0, 10);
    this.lastRunStartedAt = nowIso;
    const stats = {
      skipped: false,
      gymsProcessed: 0,
      gymsSkipped: 0,
      candidatesEvaluated: 0,
      newRemindersCreated: 0,
      retriesAttempted: 0,
      delivered: 0,
      skippedOptOut: 0,
      failed: 0,
      duplicatesPrevented: 0
    };
    try {
      const gymDocs = await paginateCollection(
        this.db.collection("gyms"),
        50,
        this.orderByField
      );
      for (const gymDoc of gymDocs) {
        if (this.stopped) break;
        const rawGym = gymDoc.data();
        const gym = { ...rawGym, id: String(rawGym.id || gymDoc.id) };
        if (gym.accountStatus === "SUSPENDED" /* SUSPENDED */ || gym.subscriptionStatus === "PENDING" /* PENDING */ || gym.subscriptionStatus === "CANCELLED" /* CANCELLED */) {
          stats.gymsSkipped += 1;
          continue;
        }
        const accessState = evaluateGymSubscriptionAccess(gym, todayIso);
        const accessUntilMs = timestampValueToMillis(gym.subscriptionAccessUntil);
        const accessExpired = accessState.isLocked || accessUntilMs === null || accessUntilMs <= nowMs;
        stats.gymsProcessed += 1;
        const settingsRef = gymDoc.ref.collection("settings").doc("default");
        const settingsSnap = await withTransientRetry(() => settingsRef.get());
        const settings = normalizeGymSettings(
          gym,
          settingsSnap.exists ? settingsSnap.data() : void 0
        );
        const existingLogDocs = await paginateCollection(
          gymDoc.ref.collection("notification_logs").where("scheduledDate", "==", todayIso),
          250
        );
        const existingLogs = existingLogDocs.map(
          (d) => d.data()
        );
        let members = [];
        let memberships = [];
        if (!accessExpired) {
          const [memberDocs, membershipDocs] = await Promise.all([
            paginateCollection(
              gymDoc.ref.collection("members"),
              250,
              this.orderByField
            ),
            paginateCollection(
              gymDoc.ref.collection("memberships"),
              250,
              this.orderByField
            )
          ]);
          members = memberDocs.map((d) => d.data());
          memberships = membershipDocs.map((d) => d.data());
        }
        const candidates = evaluateDueReminders(
          members,
          settings,
          existingLogs,
          todayIso,
          { memberships, gym }
        );
        stats.candidatesEvaluated += candidates.length;
        let touchedNewReminders = false;
        for (const c of candidates) {
          if (this.stopped) break;
          const logId = buildReminderLogId(c.dedupKey);
          const claimed = await this.claimCandidateSlot(
            gym.id,
            logId,
            workerId,
            nowMs
          );
          if (!claimed) {
            stats.duplicatesPrevented += 1;
            continue;
          }
          const claimId = `claim_${gym.id}_${logId}`;
          try {
            const attemptIso = (/* @__PURE__ */ new Date()).toISOString();
            let deliveryStatus = "SENT" /* SENT */;
            let errorDetails = "";
            let providerMessageId = "";
            let sentAt = "";
            let nextRetryAt = "";
            if (c.skippedOptOut) {
              deliveryStatus = "SKIPPED_OPT_OUT" /* SKIPPED_OPT_OUT */;
              stats.skippedOptOut += 1;
            } else if (c.channel === "IN_APP" /* IN_APP */) {
              deliveryStatus = "SENT" /* SENT */;
              sentAt = attemptIso;
              stats.delivered += 1;
              const notifId = `gnotif_${crypto3.randomBytes(8).toString("hex")}`;
              await withTransientRetry(
                () => gymDoc.ref.collection("notifications").doc(notifId).set({
                  id: notifId,
                  gymId: gym.id,
                  type: `REMINDER_${c.category}`,
                  title: c.subject.slice(0, 160),
                  message: c.message.slice(0, 500),
                  isRead: false,
                  createdAt: this.serverTimestamp()
                })
              );
            } else {
              const outcome = c.channel === "EMAIL" /* EMAIL */ ? await this.sendEmail({
                to: c.recipient,
                subject: c.subject,
                text: c.message,
                fromName: settings.emailFromName || gym.name
              }) : await this.sendWhatsApp({
                phone: c.recipient,
                phoneNumberId: settings.whatsappPhoneNumberId,
                templateName: settings.whatsappApprovedTemplate,
                templateParams: [c.memberName, c.template.replace(/_/g, " ")],
                messageText: c.message
              });
              if (outcome.delivered) {
                deliveryStatus = "SENT" /* SENT */;
                providerMessageId = outcome.providerMessageId || "";
                sentAt = outcome.sentAt || attemptIso;
                stats.delivered += 1;
              } else {
                deliveryStatus = "RETRY_SCHEDULED" /* RETRY_SCHEDULED */;
                errorDetails = (outcome.errorDetails || "Delivery attempt failed").slice(
                  0,
                  400
                );
                const backoffMin = computeRetryBackoffMinutes(0);
                nextRetryAt = new Date(nowMs + backoffMin * 6e4).toISOString();
                stats.failed += 1;
              }
            }
            await withTransientRetry(
              () => gymDoc.ref.collection("notification_logs").doc(logId).set({
                id: logId,
                gymId: gym.id,
                memberId: c.memberId,
                memberName: c.memberName,
                recipient: c.recipient,
                channel: c.channel,
                category: c.category,
                template: c.template,
                dedupKey: c.dedupKey,
                scheduledDate: c.scheduledDate,
                deliveryStatus,
                retryCount: 0,
                lastAttemptAt: attemptIso,
                ...sentAt ? { sentAt } : {},
                ...providerMessageId ? { providerMessageId } : {},
                ...errorDetails ? { errorDetails } : {},
                ...nextRetryAt ? { nextRetryAt } : {},
                createdAt: this.serverTimestamp(),
                updatedAt: this.serverTimestamp()
              })
            );
            stats.newRemindersCreated += 1;
            touchedNewReminders = true;
          } finally {
            await this.releaseItemLock(claimId, workerId);
          }
        }
        if (touchedNewReminders || settingsSnap.exists && settings.lastReminderRunDate !== todayIso) {
          if (settingsSnap.exists) {
            await withTransientRetry(
              () => settingsRef.update({
                lastReminderRunDate: todayIso,
                updatedAt: this.serverTimestamp()
              })
            );
          }
        }
        if (accessExpired) continue;
        const retryQueryDocs = await paginateCollection(
          gymDoc.ref.collection("notification_logs").where("deliveryStatus", "==", "RETRY_SCHEDULED" /* RETRY_SCHEDULED */),
          100,
          void 0,
          500
        );
        for (const retryDoc of retryQueryDocs) {
          if (this.stopped) break;
          const candidateLog = retryDoc.data();
          if (!isRetryDue(candidateLog, nowIso)) continue;
          if ((candidateLog.retryCount || 0) >= MAX_REMINDER_RETRIES) continue;
          const claimedLog = await this.claimRetrySlot(
            gym.id,
            retryDoc.id,
            workerId,
            nowMs,
            nowIso
          );
          if (!claimedLog) {
            stats.duplicatesPrevented += 1;
            continue;
          }
          const claimId = `retry_${gym.id}_${retryDoc.id}`;
          try {
            stats.retriesAttempted += 1;
            const attemptMs = nowMs;
            const attemptIso = nowIso;
            const subject = `${gym.name}: Reminder (${claimedLog.template.replace(/_/g, " ")})`;
            const message = `Hi ${claimedLog.memberName}, this is a reminder from ${gym.name} regarding ${claimedLog.template.replace(/_/g, " ").toLowerCase()}.`;
            let outcome = {
              delivered: false,
              errorDetails: "Unsupported channel for retry"
            };
            if (claimedLog.channel === "IN_APP" /* IN_APP */) {
              outcome = {
                delivered: true,
                providerMessageId: `inapp_retry_${attemptMs}`,
                sentAt: attemptIso
              };
            } else if (claimedLog.channel === "EMAIL" /* EMAIL */) {
              outcome = await this.sendEmail({
                to: claimedLog.recipient,
                subject,
                text: message,
                fromName: settings.emailFromName || gym.name
              });
            } else if (claimedLog.channel === "WHATSAPP_CLOUD" /* WHATSAPP_CLOUD */) {
              outcome = await this.sendWhatsApp({
                phone: claimedLog.recipient,
                phoneNumberId: settings.whatsappPhoneNumberId,
                templateName: settings.whatsappApprovedTemplate,
                templateParams: [
                  claimedLog.memberName,
                  claimedLog.template.replace(/_/g, " ")
                ],
                messageText: message
              });
            }
            const next = computeNextRetryState(
              claimedLog,
              outcome.delivered,
              outcome.errorDetails,
              attemptMs
            );
            if (outcome.delivered) {
              stats.delivered += 1;
              await withTransientRetry(
                () => retryDoc.ref.update({
                  deliveryStatus: next.nextStatus,
                  retryCount: next.nextRetryCount,
                  errorDetails: "",
                  providerMessageId: outcome.providerMessageId || "",
                  sentAt: outcome.sentAt || attemptIso,
                  lastAttemptAt: attemptIso,
                  nextRetryAt: "",
                  updatedAt: this.serverTimestamp()
                })
              );
            } else {
              stats.failed += 1;
              await withTransientRetry(
                () => retryDoc.ref.update({
                  deliveryStatus: next.nextStatus,
                  retryCount: next.nextRetryCount,
                  errorDetails: (next.errorDetails || "Delivery failed").slice(0, 400),
                  lastAttemptAt: attemptIso,
                  nextRetryAt: next.nextRetryAt,
                  updatedAt: this.serverTimestamp()
                })
              );
            }
          } finally {
            await this.releaseItemLock(claimId, workerId);
          }
        }
      }
      this.totalRuns += 1;
      this.lastRunFinishedAt = (/* @__PURE__ */ new Date()).toISOString();
      this.lastRunStats = stats;
      emitStructuredLog("info", "reminder-worker", "sweep_completed", {
        workerId,
        ...stats
      });
      return stats;
    } finally {
      await this.releaseDistributedLock(workerId);
    }
  }
};

// server.ts
var __filename = fileURLToPath(import.meta.url);
var __dirname = path.dirname(__filename);
function resolveProjectFile(relativePath) {
  const candidates = [
    path.resolve(process.cwd(), relativePath),
    path.resolve(__dirname, relativePath),
    path.resolve(__dirname, "..", relativePath)
  ];
  return candidates.find((p) => fs.existsSync(p)) || candidates[0];
}
function loadFirebaseConfig() {
  const cfgPath = resolveProjectFile("firebase-applet-config.json");
  if (!fs.existsSync(cfgPath)) {
    throw new Error(`Missing firebase-applet-config.json at ${cfgPath}`);
  }
  const parsed = JSON.parse(
    fs.readFileSync(cfgPath, "utf-8")
  );
  if (!parsed.projectId) {
    throw new Error("Invalid firebase-applet-config.json: missing projectId.");
  }
  return parsed;
}
function parseCliServerArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--port" && argv[i + 1]) {
      result.port = argv[++i];
    } else if (arg.startsWith("--port=")) {
      result.port = arg.slice("--port=".length);
    } else if (arg === "--host" && argv[i + 1]) {
      result.host = argv[++i];
    } else if (arg.startsWith("--host=")) {
      result.host = arg.slice("--host=".length);
    }
  }
  return result;
}
function validateEnv() {
  const cliArgs = parseCliServerArgs(process.argv.slice(2));
  const envPort = process.env.PORT?.trim();
  const nginxPort = process.env.NGINX_PORT?.trim();
  const fallbackAppPort = process.env.DEFAULT_APP_PORT?.trim() || "3000";
  const rawPort = cliArgs.port?.trim() || (envPort && (!nginxPort || envPort !== nginxPort) ? envPort : fallbackAppPort);
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `Invalid PORT "${rawPort}". Must be an integer between 1 and 65535.`
    );
  }
  const host = cliArgs.host?.trim() || process.env.HOST?.trim() || "0.0.0.0";
  const smtpHost = process.env.SMTP_HOST?.trim() || "";
  const rawSmtpPort = process.env.SMTP_PORT?.trim() || "587";
  const smtpPort = Number(rawSmtpPort);
  if (smtpHost && (!Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65535)) {
    throw new Error(
      `Invalid SMTP_PORT "${rawSmtpPort}". Must be a valid TCP port.`
    );
  }
  const smtpSecure = process.env.SMTP_SECURE?.trim().toLowerCase() === "true";
  const smtpUser = process.env.SMTP_USER?.trim() || "";
  const smtpPass = process.env.SMTP_PASS?.trim() || "";
  const smtpFrom = process.env.SMTP_FROM?.trim() || (smtpUser ? `GymOS <${smtpUser}>` : "");
  const emailConfigured = Boolean(smtpHost && smtpUser && smtpPass);
  const whatsappAccessToken = process.env.WHATSAPP_CLOUD_ACCESS_TOKEN?.trim() || "";
  const whatsappApiVersion = process.env.WHATSAPP_API_VERSION?.trim() || "v20.0";
  const whatsappConfigured = Boolean(whatsappAccessToken);
  const bootstrapToken = process.env.SUPER_ADMIN_BOOTSTRAP_TOKEN?.trim() || "";
  const bootstrapEmail = process.env.SUPER_ADMIN_BOOTSTRAP_EMAIL?.trim().toLowerCase() || "";
  if (bootstrapEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(bootstrapEmail)) {
    throw new Error(
      `Invalid SUPER_ADMIN_BOOTSTRAP_EMAIL "${bootstrapEmail}". Must be a valid email address.`
    );
  }
  const rawInterval = process.env.REMINDER_WORKER_INTERVAL_MINUTES?.trim() || "30";
  const reminderWorkerIntervalMinutes = Number(rawInterval);
  if (!Number.isFinite(reminderWorkerIntervalMinutes) || reminderWorkerIntervalMinutes < 0) {
    throw new Error(
      `Invalid REMINDER_WORKER_INTERVAL_MINUTES "${rawInterval}". Must be a non-negative number.`
    );
  }
  let serviceAccount = null;
  const rawSa = process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim();
  if (rawSa) {
    try {
      const parsed = JSON.parse(rawSa);
      if (!parsed.project_id || !parsed.private_key || !parsed.client_email) {
        throw new Error("Missing project_id, private_key, or client_email.");
      }
      serviceAccount = parsed;
    } catch (err) {
      throw new Error(
        `Invalid FIREBASE_SERVICE_ACCOUNT_JSON: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  const hasGoogleAdc = Boolean(
    process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim()
  );
  return {
    port,
    host,
    appUrl: process.env.APP_URL?.trim() || `http://localhost:${port}`,
    smtpHost,
    smtpPort,
    smtpSecure,
    smtpUser,
    smtpPass,
    smtpFrom,
    emailConfigured,
    whatsappAccessToken,
    whatsappApiVersion,
    whatsappConfigured,
    bootstrapToken,
    bootstrapEmail,
    cronSecret: process.env.CRON_SECRET?.trim() || "",
    reminderWorkerIntervalMinutes,
    serviceAccount,
    hasGoogleAdc
  };
}
var env = validateEnv();
var firebaseConfig = loadFirebaseConfig();
var adminApp;
var adminDb = null;
if (env.serviceAccount) {
  adminApp = getApps().length ? getApp() : initializeApp({
    credential: cert(env.serviceAccount),
    projectId: firebaseConfig.projectId
  });
  adminDb = firebaseConfig.firestoreDatabaseId && firebaseConfig.firestoreDatabaseId !== "(default)" ? getFirestore(adminApp, firebaseConfig.firestoreDatabaseId) : getFirestore(adminApp);
} else if (env.hasGoogleAdc) {
  adminApp = getApps().length ? getApp() : initializeApp({
    credential: applicationDefault(),
    projectId: firebaseConfig.projectId
  });
  adminDb = firebaseConfig.firestoreDatabaseId && firebaseConfig.firestoreDatabaseId !== "(default)" ? getFirestore(adminApp, firebaseConfig.firestoreDatabaseId) : getFirestore(adminApp);
} else {
  adminApp = getApps().length ? getApp() : initializeApp({ projectId: firebaseConfig.projectId });
}
var adminAuth = getAuth(adminApp);
var dbClient = adminDb;
var smtpTransporter = env.emailConfigured ? nodemailer.createTransport({
  host: env.smtpHost,
  port: env.smtpPort,
  secure: env.smtpSecure,
  auth: {
    user: env.smtpUser,
    pass: env.smtpPass
  }
}) : null;
async function sendEmailReal(input) {
  if (!smtpTransporter || !env.smtpFrom) {
    return {
      delivered: false,
      errorDetails: "SMTP is not configured on the server (set SMTP_HOST, SMTP_USER, SMTP_PASS, SMTP_FROM)."
    };
  }
  const email = input.to.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return {
      delivered: false,
      errorDetails: `Invalid recipient email address: ${email || "empty"}`
    };
  }
  try {
    const cleanFrom = env.smtpFrom.includes("<") ? `${(input.fromName || "GymOS").replace(/["<>]/g, "")} <${env.smtpFrom.split("<")[1].replace(">", "").trim()}>` : env.smtpFrom;
    const info = await smtpTransporter.sendMail({
      from: cleanFrom,
      to: email,
      subject: input.subject.slice(0, 180),
      text: input.text
    });
    return {
      delivered: true,
      providerMessageId: info.messageId || `smtp_${Date.now()}`,
      sentAt: (/* @__PURE__ */ new Date()).toISOString()
    };
  } catch (err) {
    return {
      delivered: false,
      errorDetails: err instanceof Error ? err.message : "SMTP delivery failed"
    };
  }
}
async function sendWhatsAppReal(input) {
  if (!env.whatsappConfigured) {
    return {
      delivered: false,
      errorDetails: "WHATSAPP_CLOUD_ACCESS_TOKEN is not configured on the server."
    };
  }
  const phoneNumberId = input.phoneNumberId?.trim();
  if (!phoneNumberId) {
    return {
      delivered: false,
      errorDetails: "Gym WhatsApp Phone Number ID is missing."
    };
  }
  const digits = input.phone.replace(/\D/g, "");
  if (digits.length < 10 || digits.length > 15) {
    return {
      delivered: false,
      errorDetails: `Invalid WhatsApp phone number (expected E.164 digits): ${input.phone}`
    };
  }
  const endpoint = `https://graph.facebook.com/${encodeURIComponent(env.whatsappApiVersion)}/${encodeURIComponent(phoneNumberId)}/messages`;
  const bodyPayload = input.templateName?.trim() ? {
    messaging_product: "whatsapp",
    to: digits,
    type: "template",
    template: {
      name: input.templateName.trim(),
      language: { code: "en" },
      ...input.templateParams && input.templateParams.length > 0 ? {
        components: [
          {
            type: "body",
            parameters: input.templateParams.map((text) => ({
              type: "text",
              text: String(text).slice(0, 200)
            }))
          }
        ]
      } : {}
    }
  } : {
    messaging_product: "whatsapp",
    to: digits,
    type: "text",
    text: { body: input.messageText.slice(0, 1e3) }
  };
  try {
    const resp = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.whatsappAccessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(bodyPayload)
    });
    const json = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      return {
        delivered: false,
        errorDetails: json?.error?.message || `WhatsApp Graph API HTTP ${resp.status}`
      };
    }
    return {
      delivered: true,
      providerMessageId: json?.messages?.[0]?.id || `wa_${Date.now()}`,
      sentAt: (/* @__PURE__ */ new Date()).toISOString()
    };
  } catch (err) {
    return {
      delivered: false,
      errorDetails: err instanceof Error ? err.message : "WhatsApp Cloud API request failed"
    };
  }
}
async function verifyBearerUser(req) {
  const authHeader = req.headers.authorization || "";
  const match = /^Bearer\s+(.+)$/i.exec(authHeader);
  if (!match) {
    throw new Error("Missing Authorization Bearer token.");
  }
  const decoded = await adminAuth.verifyIdToken(match[1].trim());
  if (!decoded.email || decoded.email_verified !== true) {
    throw new Error("Verified email authentication is required.");
  }
  return decoded;
}
var rateLimiter = new SlidingWindowRateLimiter();
var bootstrapController = new BootstrapController();
var reminderWorker = new ReminderWorker({
  db: dbClient,
  sendEmail: sendEmailReal,
  sendWhatsApp: sendWhatsAppReal,
  serverTimestamp: () => FieldValue.serverTimestamp(),
  intervalMinutes: env.reminderWorkerIntervalMinutes,
  orderByField: "id"
});
async function startServer() {
  const bootstrapSyncPromise = dbClient ? bootstrapController.syncFromDatabase(dbClient) : Promise.resolve(false);
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(express.json({ limit: "512kb" }));
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    next();
  });
  app.get("/healthz", (_req, res) => {
    res.status(200).json({
      status: "ok",
      uptimeSeconds: Math.round(process.uptime()),
      capabilities: {
        emailConfigured: env.emailConfigured,
        whatsappConfigured: env.whatsappConfigured,
        adminFirestoreConfigured: Boolean(adminDb),
        adminBootstrapConfigured: bootstrapController.isWebBootstrapEnabled(
          env.bootstrapToken,
          env.bootstrapEmail
        ),
        bootstrapCompleted: bootstrapController.isCompleted,
        cronConfigured: Boolean(env.cronSecret)
      },
      reminderWorker: reminderWorker.getStatus()
    });
  });
  app.get("/api/notifications/capabilities", async (_req, res) => {
    await bootstrapSyncPromise;
    res.status(200).json({
      emailConfigured: env.emailConfigured,
      whatsappConfigured: env.whatsappConfigured,
      adminFirestoreConfigured: Boolean(adminDb),
      adminBootstrapConfigured: bootstrapController.isWebBootstrapEnabled(
        env.bootstrapToken,
        env.bootstrapEmail
      ),
      cronConfigured: Boolean(env.cronSecret),
      smtpFrom: env.emailConfigured ? env.smtpFrom : ""
    });
  });
  app.post("/api/notifications/send", async (req, res) => {
    let decoded;
    try {
      decoded = await verifyBearerUser(req);
    } catch (err) {
      res.status(401).json({
        delivered: false,
        errorDetails: err instanceof Error ? err.message : "Unauthorized"
      });
      return;
    }
    let authorized;
    try {
      authorized = await authorizeAndResolveNotificationDispatch({
        db: dbClient,
        rateLimiter,
        actor: {
          uid: decoded.uid,
          email: decoded.email || "",
          emailVerified: decoded.email_verified === true
        },
        body: req.body || {},
        serverTimestamp: () => FieldValue.serverTimestamp()
      });
    } catch (err) {
      if (err instanceof HttpError) {
        res.status(err.status).json({
          delivered: false,
          code: err.code,
          errorDetails: err.message
        });
        return;
      }
      emitStructuredLog("error", "notification-send", "authorization_error", {
        error: err instanceof Error ? err.message : String(err)
      });
      res.status(500).json({
        delivered: false,
        errorDetails: "Failed to authorize notification request."
      });
      return;
    }
    if (authorized.channel === "EMAIL") {
      const outcome2 = await sendEmailReal({
        to: authorized.recipient,
        subject: authorized.subject,
        text: authorized.message,
        fromName: authorized.fromName
      });
      res.status(200).json(outcome2);
      return;
    }
    const outcome = await sendWhatsAppReal({
      phone: authorized.recipient,
      phoneNumberId: authorized.whatsappPhoneNumberId,
      templateName: authorized.whatsappApprovedTemplate,
      templateParams: authorized.whatsappTemplateParams,
      messageText: authorized.message
    });
    res.status(200).json(outcome);
  });
  app.post("/api/admin/bootstrap", async (req, res) => {
    let decoded;
    try {
      decoded = await verifyBearerUser(req);
    } catch (err) {
      res.status(401).json({
        ok: false,
        error: err instanceof Error ? err.message : "Unauthorized"
      });
      return;
    }
    const { bootstrapToken, displayName } = req.body || {};
    try {
      await bootstrapSyncPromise;
      const result = await bootstrapController.executeWebBootstrap({
        db: dbClient,
        rateLimiter,
        clientIp: req.ip || req.socket.remoteAddress || "unknown",
        actor: {
          uid: decoded.uid,
          email: decoded.email || "",
          emailVerified: decoded.email_verified === true
        },
        displayName,
        bootstrapToken,
        configuredToken: env.bootstrapToken,
        configuredEmail: env.bootstrapEmail,
        serverTimestamp: () => FieldValue.serverTimestamp(),
        onSuccessInvalidateSecrets: () => {
          env.bootstrapToken = "";
          env.bootstrapEmail = "";
        }
      });
      res.status(200).json({ ok: true, uid: result.uid, email: result.email });
    } catch (err) {
      if (err instanceof HttpError) {
        res.status(err.status).json({
          ok: false,
          code: err.code,
          error: err.message
        });
        return;
      }
      emitStructuredLog("error", "admin-bootstrap", "bootstrap_error", {
        error: err instanceof Error ? err.message : String(err)
      });
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : "Failed to initialize Super Admin."
      });
    }
  });
  app.post("/api/cron/reminders", async (req, res) => {
    if (!env.cronSecret) {
      res.status(403).json({ ok: false, error: "CRON_SECRET is not configured on the server." });
      return;
    }
    const authHeader = req.headers.authorization || "";
    const match = /^Bearer\s+(.+)$/i.exec(authHeader);
    if (!match || !timingSafeMatch(match[1].trim(), env.cronSecret)) {
      res.status(401).json({ ok: false, error: "Invalid cron authorization token." });
      return;
    }
    try {
      const result = await reminderWorker.sweep();
      res.status(200).json({ ok: true, ...result });
    } catch (err) {
      emitStructuredLog("error", "cron-reminders", "sweep_failed", {
        error: err instanceof Error ? err.message : String(err)
      });
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : "Cron sweep failed"
      });
    }
  });
  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa"
    });
    app.use(vite.middlewares);
  } else {
    const distCandidates = [
      path.resolve(__dirname, "dist"),
      path.resolve(__dirname, "..", "dist"),
      path.resolve(process.cwd(), "dist")
    ];
    const distDir = distCandidates.find((dir) => fs.existsSync(path.join(dir, "index.html"))) || path.resolve(process.cwd(), "dist");
    const indexFile = path.join(distDir, "index.html");
    app.use(
      "/assets",
      express.static(path.join(distDir, "assets"), {
        maxAge: "1y",
        immutable: true
      })
    );
    app.use(
      express.static(distDir, {
        index: false,
        maxAge: "1h"
      })
    );
    app.get("*", (_req, res) => {
      if (!fs.existsSync(indexFile)) {
        res.status(503).send("Application bundle not built. Run npm run build first.");
        return;
      }
      res.setHeader("Cache-Control", "no-cache");
      res.sendFile(indexFile);
    });
  }
  const httpServer = app.listen(env.port, env.host, () => {
    emitStructuredLog("info", "server", "listening", {
      port: env.port,
      host: env.host,
      emailConfigured: env.emailConfigured,
      whatsappConfigured: env.whatsappConfigured,
      adminFirestoreConfigured: Boolean(adminDb),
      bootstrapEnabled: bootstrapController.isWebBootstrapEnabled(
        env.bootstrapToken,
        env.bootstrapEmail
      ),
      reminderWorkerIntervalMinutes: env.reminderWorkerIntervalMinutes
    });
  });
  if (adminDb && env.reminderWorkerIntervalMinutes > 0) {
    reminderWorker.start();
  }
  const shutdown = async (signal) => {
    emitStructuredLog("info", "server", "shutdown_initiated", { signal });
    await reminderWorker.stop();
    await new Promise((resolve) => {
      httpServer.close(() => resolve());
    });
    process.exit(0);
  };
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });
}
startServer().catch((err) => {
  emitStructuredLog("error", "server", "fatal_startup_error", {
    error: err instanceof Error ? err.message : String(err)
  });
  process.exit(1);
});
