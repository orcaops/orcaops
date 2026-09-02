// Single source of truth for VitePress sidebar sections, page order, and titles.
// Each page is `content/<slug>.md`, and <slug> is its clean public URL.
export const sections = [
  {
    title: 'Start locally',
    items: [
      { slug: 'getting-started', title: 'Getting started' },
      { slug: 'seed', title: 'Import Git history' },
      { slug: 'local-data', title: 'Local data and privacy' },
    ],
  },
  {
    title: 'Work through your agent',
    items: [
      { slug: 'working-with-your-agent', title: 'Working with your agent' },
      { slug: 'skills', title: 'Skills' },
      { slug: 'task-review', title: 'Task Review and Watch' },
      { slug: 'evaluators', title: 'Evaluators' },
    ],
  },
  {
    title: 'Teams and Cloud',
    items: [
      { slug: 'team-adoption', title: 'Adopt as a team' },
      { slug: 'cloud-collaboration', title: 'Cloud collaboration' },
      { slug: 'authentication', title: 'Authentication' },
      { slug: 'plan-review', title: 'Plan review' },
    ],
  },
  {
    title: 'Reference and extensions',
    items: [
      { slug: 'configuration', title: 'Configuration' },
      { slug: 'agent-integrations', title: 'Agent integrations' },
      { slug: 'session-hooks', title: 'Session hooks' },
      { slug: 'data-configuration', title: 'Capture and data' },
      { slug: 'troubleshooting', title: 'Troubleshooting' },
      { slug: 'command-reference', title: 'Command reference' },
      { slug: 'glossary', title: 'Glossary' },
      { slug: 'authoring-evaluator-packs', title: 'Authoring evaluator packs' },
      { slug: 'task-review-protocol', title: 'Task Review protocol' },
    ],
  },
];

export const pages = sections.flatMap((section) => section.items);
