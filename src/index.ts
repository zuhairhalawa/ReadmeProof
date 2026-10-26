export { main, HELP } from './cli.js';
export type { CliIo } from './cli.js';
export { parseMarkdown } from './markdown.js';
export { parseAnnotationBody, extractAnnotationBody, hasAssertions } from './annotations.js';
export { runStaticChecks } from './checks.js';
export { discoverProject, resolveReadme } from './project.js';
export { verifyBlocks } from './verify.js';
export { buildRunArgs, createDockerRuntime, detectDocker, DEFAULT_IMAGE } from './docker.js';
export { buildCheckReport, buildListReport, buildVerifyReport, renderJson, renderText, EXIT } from './report.js';
export type { Report, Verdict } from './report.js';
export type * from './types.js';

