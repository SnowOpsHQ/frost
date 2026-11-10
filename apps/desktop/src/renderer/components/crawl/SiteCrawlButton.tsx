import type { ProjectSummary } from '@app/specs/projects.spec';
import { openCrawl } from './crawl-sheet';

// The "Site crawl" entry in Phase 10's project sheet (Phase 12 Task 7; acceptance `site-crawl.feature.md`,
// Pages and Site structure: Entry points), one line in `Projects.tsx`: it opens the crawl sheet on the
// project's site (`https://` + its domain; none set: the active tab's site), with the `site` scope when
// the project counts every host of its domain (`subdomains`), else `host`; a crawl started there belongs
// to the project (deleted with it). Unfiled has no site and shows no entry. Light on purpose: it
// imports only the sheet's open request, never the sheet.

export function SiteCrawlButton({ project }: { readonly project: Pick<ProjectSummary, 'id' | 'site' | 'unfiled'> }) {
  if (project.unfiled) return null;
  const startUrl = project.site === null ? null : `https://${project.site.domain}/`;
  return (
    <button type="button" className="projects-small-button" data-testid="projects-site-crawl" onClick={() => openCrawl({ startUrl, projectId: project.id, scope: project.site?.subdomains === true ? 'site' : 'host' })}>
      Site crawl
    </button>
  );
}
