export const CONSULTATION_WORKFLOW_SKILL_NAME = 'consultation-client-workflow'
export const WEEKLY_BUSINESS_DASHBOARD_SKILL_NAME = 'weekly-business-dashboard'
export const CONSULTATION_BRIEF_ACTION_MARKER =
  '<<<AI_LINZI_RUN_CUSTOMER_CONSULTATION_BRIEF>>>'

export function extractConsultationBriefAction(text: string): {
  requested: boolean
  cleanText: string
} {
  const requested = text.includes(CONSULTATION_BRIEF_ACTION_MARKER)
  if (!requested) return { requested: false, cleanText: text }
  return {
    requested: true,
    cleanText: text
      .replaceAll(CONSULTATION_BRIEF_ACTION_MARKER, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
  }
}
