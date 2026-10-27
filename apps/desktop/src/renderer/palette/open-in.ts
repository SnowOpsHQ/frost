// "Open in" URLs for the palette's rows (acceptance `command-palette.feature.md`, Open in). The
// logic is shared with main, which builds and opens the URL itself (`browser.openTool`): it lives in
// the Zod-free `open-in.spec.ts`.
export { isPublicAddress, isPublicHost, openInUrl, pageUrlToSend, sendsQuery, siteFileUrl, templateHost } from '@app/specs/open-in.spec';
