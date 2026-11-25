/**
 * Families bundled under `public/fonts` (OFL). Kept in a dependency-free
 * module because both the `@font-face` registry (`styles/fonts.ts`) and the
 * picker lists (`services/constants.ts`, `utils/style.ts`) need the names —
 * importing them from `styles/fonts.ts` would drag its runtime imports into
 * every consumer and break test mocks of that module.
 */
export const OFFLINE_SERIF_FONT = 'PT Serif (offline)';
export const OFFLINE_SANS_FONT = 'PT Sans (offline)';
