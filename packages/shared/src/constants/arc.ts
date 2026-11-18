export const ARC_NAME = 'INIT Arc';
export const ARC_INVITATION_DAYS = 7;
export const ARC_INVITE_ATTEMPTS = 3;
export const ARC_INVITES_PER_DAY = 50;
export const ARC_REPO_NAME_MAX = 100;
export const ARC_REPO_DESCRIPTION_MAX = 350;
export const ARC_LICENCE_MAX = 20_000;
export const ARC_SETTINGS_PATH = '/settings#set-accounts';

export const ARC_LICENCE_PLACEHOLDERS = [
  'project',
  'chapter',
  'start',
  'submission',
  'repository',
  'contributors',
] as const;

export type ArcLicencePlaceholder = (typeof ARC_LICENCE_PLACEHOLDERS)[number];

export const ARC_LICENCE_PLACEHOLDER_HELP: Record<
  ArcLicencePlaceholder,
  string
> = {
  project: "The project's title",
  chapter: "The chapter's name",
  start:
    "The project's start date, or the day its repository was made when it has none",
  submission: "The project's submission date",
  repository: 'The repository, as INITArc/name',
  contributors: 'The leads and the accepted team, one name per line',
};

export const ARC_REMOVAL_REASONS = [
  'left',
  'unlinked',
  'relinked',
  'account_gone',
  'closed',
] as const;

export type ArcRemovalReason = (typeof ARC_REMOVAL_REASONS)[number];

export const ARC_ACCESS_STATUSES = [
  'no_github',
  'waiting',
  'invited',
  'expired',
  'declined',
  'active',
  'account_gone',
] as const;

export type ArcAccessStatus = (typeof ARC_ACCESS_STATUSES)[number];

export const ARC_ACCESS_LABEL: Record<ArcAccessStatus, string> = {
  no_github: 'No GitHub linked',
  waiting: 'Waiting to be invited',
  invited: 'Invited',
  expired: 'Expired',
  declined: 'Declined',
  active: 'Active',
  account_gone: 'GitHub account not found',
};

export const GITHUB_REQUIRED_TO_APPLY =
  'Link your GitHub account before you apply. Every Studio team works in a repository on GitHub, and INIT invites you to it with that account. Link it in Settings, under Connected accounts.';

export const BUILD_PRESERVATION_NOTICE =
  'What your team builds is kept in INIT Arc, a public repository on GitHub. You keep the copyright in what you write. By applying you grant INIT a licence to host, preserve and display the repository and its history, and you grant your teammates a licence to use the team’s work. INIT does not use, sell or relicense it.';

export const ARC_IMPORT_BLOB_MAX = 104_857_600;
export const ARC_IMPORT_WARN_BYTES = 1_000_000_000;
export const ARC_IMPORT_PUSH_MAX = 2_147_483_648;
export const ARC_IMPORT_DISK_MAX = 8 * 1024 ** 3;
export const ARC_IMPORT_TIMEOUT_MS = 30 * 60_000;
export const ARC_IMPORT_REF_MAX = 10_000;
export const ARC_IMPORT_MANIFEST_MAX = 2_000_000;
export const ARC_IMPORT_README_MAX = 1_000_000;
