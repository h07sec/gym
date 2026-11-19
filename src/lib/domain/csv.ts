import { Member, MembershipStatus } from '../../types/gymos';

function escapeCsvCell(value: string | number | boolean | undefined | null): string {
  const str = value === undefined || value === null ? '' : String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function exportMembersToCsv(members: Member[]): string {
  const headers = [
    'Member ID',
    'Full Name',
    'Phone',
    'Email',
    'Gender',
    'Date of Birth',
    'Joining Date',
    'Plan',
    'Membership Start',
    'Membership Expiry',
    'Status',
    'Outstanding Balance',
    'Opt Out Reminders',
    'Archived',
    'Notes',
  ];

  const rows = members.map((m) =>
    [
      m.memberCode,
      m.fullName,
      m.phone,
      m.email ?? '',
      m.gender ?? '',
      m.dateOfBirth ?? '',
      m.joiningDate,
      m.currentPlanName ?? '',
      m.membershipStartDate ?? '',
      m.membershipExpiryDate ?? '',
      m.membershipStatus,
      m.outstandingBalance,
      m.reminderOptOut,
      m.isArchived,
      m.notes ?? '',
    ]
      .map(escapeCsvCell)
      .join(',')
  );

  return [headers.join(','), ...rows].join('\n');
}

export function exportGenericCsv(headers: string[], rows: (string | number | boolean)[][]): string {
  const headerLine = headers.map(escapeCsvCell).join(',');
  const bodyLines = rows.map((row) => row.map(escapeCsvCell).join(','));
  return [headerLine, ...bodyLines].join('\n');
}

export interface CsvImportRowResult {
  rowNumber: number;
  fullName: string;
  phone: string;
  email?: string;
  gender?: string;
  joiningDate: string;
  notes?: string;
  isValid: boolean;
  isDuplicate: boolean;
  errors: string[];
}

function splitCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result;
}

export function parseAndValidateMemberCsv(
  csvText: string,
  existingMembers: Member[],
  todayIso: string
): CsvImportRowResult[] {
  const lines = csvText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  if (lines.length === 0) return [];

  const existingPhones = new Set(existingMembers.map((m) => m.phone.replace(/\D/g, '')));
  const seenPhonesInFile = new Set<string>();

  const headerCells = splitCsvLine(lines[0]).map((h) => h.toLowerCase());
  const hasHeader =
    headerCells.some((h) => h.includes('name')) &&
    headerCells.some((h) => h.includes('phone'));

  const dataLines = hasHeader ? lines.slice(1) : lines;
  const idxName = hasHeader ? headerCells.findIndex((h) => h.includes('name')) : 0;
  const idxPhone = hasHeader ? headerCells.findIndex((h) => h.includes('phone')) : 1;
  const idxEmail = hasHeader ? headerCells.findIndex((h) => h.includes('email')) : 2;
  const idxGender = hasHeader ? headerCells.findIndex((h) => h.includes('gender')) : 3;
  const idxJoining = hasHeader ? headerCells.findIndex((h) => h.includes('join')) : 4;
  const idxNotes = hasHeader ? headerCells.findIndex((h) => h.includes('note')) : 5;

  return dataLines.map((line, index) => {
    const cells = splitCsvLine(line);
    const fullName = (cells[idxName] ?? '').trim();
    const phone = (cells[idxPhone] ?? '').trim();
    const email = idxEmail >= 0 ? (cells[idxEmail] ?? '').trim() : '';
    const gender = idxGender >= 0 ? (cells[idxGender] ?? '').trim() : '';
    const joiningDateRaw = idxJoining >= 0 ? (cells[idxJoining] ?? '').trim() : '';
    const joiningDate = /^\d{4}-\d{2}-\d{2}$/.test(joiningDateRaw) ? joiningDateRaw : todayIso;
    const notes = idxNotes >= 0 ? (cells[idxNotes] ?? '').trim() : '';

    const errors: string[] = [];
    if (fullName.length < 2) errors.push('Full name must be at least 2 characters');
    const normalizedPhone = phone.replace(/\D/g, '');
    if (normalizedPhone.length < 7) errors.push('Phone must contain at least 7 digits');
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      errors.push('Invalid email address');
    }

    const isDuplicate =
      normalizedPhone.length > 0 &&
      (existingPhones.has(normalizedPhone) || seenPhonesInFile.has(normalizedPhone));

    if (normalizedPhone.length > 0) {
      seenPhonesInFile.add(normalizedPhone);
    }

    if (isDuplicate) {
      errors.push('Duplicate phone number detected');
    }

    return {
      rowNumber: index + (hasHeader ? 2 : 1),
      fullName,
      phone,
      email: email || undefined,
      gender: gender || undefined,
      joiningDate,
      notes: notes || undefined,
      isValid: errors.length === 0,
      isDuplicate,
      errors,
    };
  });
}

export function triggerCsvDownload(filename: string, csvContent: string): void {
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export function defaultNewMemberStatus(): MembershipStatus {
  return MembershipStatus.NONE;
}
