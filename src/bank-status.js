// The bank's own application status on a file, per product, from MIS's "Status Categories" sheet.
// A bank status is set by MIS (one by one or from the bank's report) and the CRM's case status is
// derived from it, so incentives, payouts and the P&L keep working from Completed as before.

/** The statuses the bank reports, by product, in the order of MIS's sheet. */
export const BANK_STATUSES = {
  credit_card: [
    'COMPLETED', 'SENT_TO_RCC', 'AO_COMPLETED_SENT_TO_RCC', 'REJECTED', 'SUBMITTED', 'CANCELLED', 'REFERRED_BY_RCC',
    'AO_COMPLETED_WAITING_FOR_SALARY_TRANSFER', 'RETURNED_BY_CHECKER', 'SENT_TO_COMPLIANCE', 'AO_COMPLETED_REJECT_REVIEW',
    'SENT_TO_CHECKER', 'REJECT_REVIEW', 'DRAFT', 'REFERRED_BY_COMPLIANCE', 'AO_COMPLETED_REFERRED_BY_RCC', 'ON_HOLD',
    'AWAITING_CUSTOMER_ACTION', 'REJECTED_BY_CHECKER', 'CANCELLED_FSK_HIT', 'REJECTED_BY_COMPLIANCE', 'ERROR_IN_PROCESSING',
    'WAITING_FOR_FUNDS', 'AWAITING_USER_ACTION', 'BANK_STATEMENT_FAILED', 'AO_COMPLETED_WAITING_FOR_FUNDS', 'WAITING_FOR_SALARY_TRANSFER',
  ],
  personal_loan: [
    'COMPLETED', 'ON_HOLD', 'SENT_TO_CHECKER', 'RETURNED_BY_CHECKER', 'SENT_TO_RCC', 'AWAITING_USER_ACTION', 'REJECT_REVIEW',
    'CANCELLED', 'REFERRED_BY_RCC', 'AO_COMPLETED_REFERRED_BY_RCC', 'AO_COMPLETED_SENT_TO_RCC', 'REJECTED', 'AO_COMPLETED_REJECT_REVIEW',
    'ERROR_IN_PROCESSING', 'AWAITING_CUSTOMER_ACTION', 'SUBMITTED', 'REJECTED_BY_CHECKER', 'DRAFT', 'CANCELLED_FSK_HIT',
  ],
  // Auto loans report the current stage; a comma-separated value is several stages on one file.
  auto_loan: [
    'Dispatch Document', 'COMPLETED', 'TERMINATE', 'Document Collection', 'CIF or Account Opening', 'Refer To Sourcing', 'Sourcing',
    'NOT_APPLICABLE', 'REJECT REVIEW', 'Underwriter', 'Dealer Document Collection', 'CV', 'Fleet Creation', 'Sampling Checker',
    'Refer To Sourcing, FV, OV_Refer To Sourcing', 'Refer To Sourcing, Sampling Checker', 'Refer To Sourcing, CV_Refer To Sourcing',
    'RMFC_Refer To Sourcing', 'Underwriter, Sampling Checker, Sampling Checker', 'Vehicle Registration', 'Underwriter, Master',
    'REJECT REVIEW, Sampling Checker', 'PDOC', 'LPO', 'Refer To Sourcing, RMFC_Refer To Sourcing', 'Sourcing, RMFC_Refer To Sourcing',
    'Refer To Sourcing, FV, OV, CV', 'Refer To Sourcing, CV, OV, FV', 'CV_Refer To Sourcing',
  ],
};

// The CRM's case status each bank status means. Settled with the business:
// - COMPLETED is completed; an "AO completed" status is only the account opening, so the file is still in process
//   (AO_COMPLETED_WAITING_FOR_SALARY_TRANSFER: account opened, waiting for the salary credit).
// - rejected, cancelled and terminated files are rejected;
// - a file waiting on the customer or sent back to sourcing is in Applicant review (the sales person acts);
// - everything else is in process at the bank, which the CRM shows as Sent to checker.
const COMPLETED = new Set(['COMPLETED']);
const REJECTED = new Set(['REJECTED', 'REJECTED_BY_CHECKER', 'REJECTED_BY_COMPLIANCE', 'CANCELLED', 'CANCELLED_FSK_HIT', 'TERMINATE']);
const WITH_APPLICANT = /AWAITING_CUSTOMER_ACTION|AWAITING_USER_ACTION|RETURNED_BY_CHECKER|Refer To Sourcing|BANK_STATEMENT_FAILED/i;

/** The case status a bank status derives: completed, rejected, applicant_review or sent_to_check. */
export function caseStatusOf(bankStatus) {
  const s = String(bankStatus || '').trim();
  if (!s) return null;
  if (COMPLETED.has(s)) return 'completed';
  if (REJECTED.has(s)) return 'rejected';
  if (WITH_APPLICANT.test(s)) return 'applicant_review';
  return 'sent_to_check';
}

const ACRONYMS = new Set(['AO', 'RCC', 'FSK', 'CV', 'FV', 'OV', 'RMFC', 'PDOC', 'LPO', 'CIF']);
/** A readable form of a bank status: "AO completed, waiting for salary transfer"; stage names stay as given. */
export function bankStatusLabel(s) {
  if (!s) return '';
  if (!/^[A-Z0-9_ ]+$/.test(s)) return s;
  const words = s.replace(/_/g, ' ').trim().split(/\s+/).map((w, i) => (ACRONYMS.has(w) ? w : i === 0 ? w[0] + w.slice(1).toLowerCase() : w.toLowerCase()));
  return words.join(' ').replace(/^AO completed /, 'AO completed, ');
}

/** The bank statuses a file can take: those of every product on it. */
export function bankStatusesFor(products) {
  const out = [];
  for (const p of products) for (const s of BANK_STATUSES[p] || []) if (!out.includes(s)) out.push(s);
  return out;
}

/** Matches a typed or uploaded status to the list, ignoring case, spaces and underscores. */
export function matchBankStatus(value, products) {
  const key = (x) => String(x).toLowerCase().replace(/[\s_]+/g, ' ').replace(/\s*,\s*/g, ',').trim();
  const want = key(value || '');
  if (!want) return null;
  return bankStatusesFor(products).find((s) => key(s) === want) || null;
}
