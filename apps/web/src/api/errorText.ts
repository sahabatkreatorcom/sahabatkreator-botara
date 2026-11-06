import type { TranslationKey } from "@sahabat-kreator/i18n";
import { ApiClientError } from "./client";

type Translate = (
  key: TranslationKey,
  params?: Record<string, string | number>,
) => string;

/**
 * Petakan error API → teks i18n (RANCANGAN §11.1: API membawa kode, UI yang
 * menerjemahkan). Mencakup kode kontrak kita dan kode mentah Better Auth
 * (endpoint /api/auth/* tidak memakai format kontrak).
 */
export function translateApiError(t: Translate, err: unknown): string {
  if (!(err instanceof ApiClientError)) return t("errors.generic");

  switch (err.code) {
    // Better Auth (sign-in / sign-up)
    case "INVALID_EMAIL_OR_PASSWORD":
      return t("errors.invalidCredentials");
    case "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL":
    case "USER_ALREADY_EXISTS":
      return t("errors.userAlreadyExists");
    case "PASSWORD_TOO_SHORT":
      return t("errors.passwordTooShort");
    // Better Auth change-password: kata sandi saat ini salah.
    case "INVALID_PASSWORD":
      return t("settings.passwordCurrentWrong");
    // Better Auth reset-password (Fase 14C): token tidak dikenal,
    // kedaluwarsa, atau sudah dipakai.
    case "INVALID_TOKEN":
      return t("auth.resetInvalidBody");
    case "INVALID_EMAIL":
      return t("auth.emailInvalid");
    case "NETWORK_ERROR":
      return t("errors.network");
    // Kode kontrak yang punya terjemahan langsung di resource `errors.*`
    case "UNAUTHORIZED":
      return t("errors.UNAUTHORIZED");
    case "FORBIDDEN":
      return t("errors.FORBIDDEN");
    case "VALIDATION_ERROR":
      return t("errors.VALIDATION_ERROR");
    case "INTERNAL_ERROR":
      return t("errors.INTERNAL_ERROR");
    case "TENANT_NOT_FOUND":
      return t("errors.TENANT_NOT_FOUND");
    case "NOT_FOUND":
      return t("errors.NOT_FOUND");
    case "RATE_LIMITED":
      return t("errors.RATE_LIMITED");
    case "APPOINTMENT_TIMEZONE_INVALID":
      return t("errors.APPOINTMENT_TIMEZONE_INVALID");
    case "SLOT_TAKEN":
      return t("errors.SLOT_TAKEN");
    case "GOOGLE_NOT_CONFIGURED":
      return t("errors.GOOGLE_NOT_CONFIGURED");
    case "GOOGLE_NOT_CONNECTED":
      return t("errors.GOOGLE_NOT_CONNECTED");
    case "GOOGLE_UNREACHABLE":
      return t("errors.GOOGLE_UNREACHABLE");
    case "CHANNEL_NOT_AVAILABLE_YET":
      return t("errors.CHANNEL_NOT_AVAILABLE_YET");
    case "CHANNEL_NOT_CONNECTED":
      return t("errors.CHANNEL_NOT_CONNECTED");
    case "TELEGRAM_TOKEN_INVALID":
      return t("errors.TELEGRAM_TOKEN_INVALID");
    case "TELEGRAM_BOT_ALREADY_CONNECTED":
      return t("errors.TELEGRAM_BOT_ALREADY_CONNECTED");
    case "META_TOKEN_INVALID":
      return t("errors.META_TOKEN_INVALID");
    case "META_ACCOUNT_ALREADY_CONNECTED":
      return t("errors.META_ACCOUNT_ALREADY_CONNECTED");
    case "META_OAUTH_NOT_CONFIGURED":
      return t("errors.META_OAUTH_NOT_CONFIGURED");
    case "META_OAUTH_STATE_INVALID":
      return t("errors.META_OAUTH_STATE_INVALID");
    case "META_OAUTH_SESSION_NOT_FOUND":
      return t("errors.META_OAUTH_SESSION_NOT_FOUND");
    case "META_OAUTH_ASSET_NOT_FOUND":
      return t("errors.META_OAUTH_ASSET_NOT_FOUND");
    case "META_OAUTH_EXCHANGE_FAILED":
      return t("errors.META_OAUTH_EXCHANGE_FAILED");
    case "META_OAUTH_CANCELLED":
      return t("errors.META_OAUTH_CANCELLED");
    case "CHANNEL_DELETE_CONFIRMATION_MISMATCH":
      return t("errors.CHANNEL_DELETE_CONFIRMATION_MISMATCH");
    case "CHANNEL_ALREADY_TRASHED":
      return t("errors.CHANNEL_ALREADY_TRASHED");
    case "CHANNEL_NOT_TRASHED":
      return t("errors.CHANNEL_NOT_TRASHED");
    case "PRODUCT_HAS_LINKS":
      return t("errors.PRODUCT_HAS_LINKS");
    case "CHANNEL_DISCONNECTED":
      return t("errors.CHANNEL_DISCONNECTED");
    case "LOG_REPLAY_NOT_ALLOWED":
      return t("errors.LOG_REPLAY_NOT_ALLOWED");
    case "LOG_PAYLOAD_TRUNCATED":
      return t("errors.LOG_PAYLOAD_TRUNCATED");
    case "MESSAGE_NOT_FAILED":
      return t("errors.MESSAGE_NOT_FAILED");
    case "MESSAGE_RETRY_UNSUPPORTED":
      return t("errors.MESSAGE_RETRY_UNSUPPORTED");
    case "FLOW_INVALID_STATE":
      return t("errors.FLOW_INVALID_STATE");
    case "FLOW_GRAPH_INVALID":
      return t("errors.FLOW_GRAPH_INVALID");
    case "FLOW_TEMPLATE_NOT_FOUND":
      return t("errors.FLOW_TEMPLATE_NOT_FOUND");
    case "AUTOMATION_TEMPLATE_NOT_FOUND":
      return t("errors.AUTOMATION_TEMPLATE_NOT_FOUND");
    case "KB_DOCUMENT_NO_TEXT":
      return t("errors.KB_DOCUMENT_NO_TEXT");
    case "KB_DOCUMENT_TYPE_UNSUPPORTED":
      return t("errors.KB_DOCUMENT_TYPE_UNSUPPORTED");
    case "KB_DOCUMENT_TOO_LARGE":
      return t("errors.KB_DOCUMENT_TOO_LARGE");
    case "AGENT_PROVIDER_ERROR":
      return t("errors.AGENT_PROVIDER_ERROR");
    case "GROWTH_LINK_SLUG_TAKEN":
      return t("errors.GROWTH_LINK_SLUG_TAKEN");
    case "GROWTH_LINK_CHANNEL_INVALID":
      return t("errors.GROWTH_LINK_CHANNEL_INVALID");
    case "GROWTH_LINK_TARGET_UNAVAILABLE":
      return t("errors.GROWTH_LINK_TARGET_UNAVAILABLE");
    case "ASSIGNEE_NOT_MEMBER":
      return t("errors.ASSIGNEE_NOT_MEMBER");
    case "MESSAGING_WINDOW_CLOSED":
      return t("errors.MESSAGING_WINDOW_CLOSED");
    case "MESSAGE_TEMPLATE_UNSUPPORTED":
      return t("errors.MESSAGE_TEMPLATE_UNSUPPORTED");
    case "MESSAGE_TEMPLATE_NOT_FOUND":
      return t("errors.MESSAGE_TEMPLATE_NOT_FOUND");
    case "MESSAGE_TEMPLATE_NOT_APPROVED":
      return t("errors.MESSAGE_TEMPLATE_NOT_APPROVED");
    case "MESSAGE_TEMPLATE_MEDIA_HEADER_UNSUPPORTED":
      return t("errors.MESSAGE_TEMPLATE_MEDIA_HEADER_UNSUPPORTED");
    case "MESSAGE_TEMPLATE_PARAMS_INVALID":
      return t("errors.MESSAGE_TEMPLATE_PARAMS_INVALID");
    case "MEDIA_NOT_FOUND":
      return t("errors.MEDIA_NOT_FOUND");
    case "MEDIA_TYPE_UNSUPPORTED":
      return t("errors.MEDIA_TYPE_UNSUPPORTED");
    case "MEDIA_TOO_LARGE":
      return t("errors.MEDIA_TOO_LARGE");
    case "MEDIA_EMPTY":
      return t("errors.MEDIA_EMPTY");
    case "INVITATION_EXPIRED":
      return t("errors.INVITATION_EXPIRED");
    case "INVITATION_REVOKED":
      return t("errors.INVITATION_REVOKED");
    case "INVITATION_ALREADY_ACCEPTED":
      return t("errors.INVITATION_ALREADY_ACCEPTED");
    case "INVITATION_EMAIL_MISMATCH":
      return t("errors.INVITATION_EMAIL_MISMATCH");
    case "INVITATION_ALREADY_MEMBER":
      return t("errors.INVITATION_ALREADY_MEMBER");
    case "TEAM_OWNER_PROTECTED":
      return t("errors.TEAM_OWNER_PROTECTED");
    case "TEAM_SELF_ACTION":
      return t("errors.TEAM_SELF_ACTION");
    case "BROADCAST_CHANNEL_UNSUPPORTED":
      return t("errors.BROADCAST_CHANNEL_UNSUPPORTED");
    case "BROADCAST_TEMPLATE_REQUIRED":
      return t("errors.BROADCAST_TEMPLATE_REQUIRED");
    case "BROADCAST_TEMPLATE_NOT_APPROVED":
      return t("errors.BROADCAST_TEMPLATE_NOT_APPROVED");
    case "BROADCAST_AB_INCOMPLETE":
      return t("errors.BROADCAST_AB_INCOMPLETE");
    case "META_TEMPLATE_INVALID":
      return t("errors.META_TEMPLATE_INVALID");
    case "META_WABA_MISSING":
      return t("errors.META_WABA_MISSING");
    default:
      break;
  }

  if (err.status === 401) return t("errors.invalidCredentials");
  if (err.status === 400 || err.status === 422)
    return t("errors.VALIDATION_ERROR");
  return t("errors.generic");
}
