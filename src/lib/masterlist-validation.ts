export const STUDENT_NUMBER_PATTERN = /^\d{4}-\d{5}-SP-\d$/;
export const SCHOOL_YEAR_PATTERN = /^(\d{4})-(\d{4})$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type MasterlistValues = {
  sn: string;
  name: string;
  email: string;
  course: string;
  year: string;
  schoolYear: string;
};

/** A school year must be consecutive four-digit years, e.g. 2026-2027. */
export function isValidSchoolYear(value: string): boolean {
  const match = SCHOOL_YEAR_PATTERN.exec(value.trim());
  if (!match) return false;
  const start = Number(match[1]);
  const end = Number(match[2]);
  return start >= 2000 && end === start + 1;
}

export function masterlistValidationError(values: MasterlistValues): string | null {
  if (!STUDENT_NUMBER_PATTERN.test(values.sn.trim().toUpperCase())) return "Student number must use the format YYYY-#####-SP-#.";
  if (values.name.trim().length < 2) return "Enter the student's full name.";
  if (!EMAIL_PATTERN.test(values.email.trim())) return "Enter a valid email address.";
  if (!values.course.trim()) return "Course is required.";
  if (!values.year.trim()) return "Year level is required.";
  if (!isValidSchoolYear(values.schoolYear)) return "School year must use consecutive years in YYYY-YYYY format (example: 2026-2027).";
  return null;
}
