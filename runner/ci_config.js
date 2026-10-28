'use strict';

// Which changed paths are CI configuration. A pull request that changes one is
// opened as a draft whatever the job's `draft` key says, because the platform
// applies the same rule to its own pull requests and a person reviews a change
// to the pipeline before it runs.
//
// This mirrors SRE Agent's own rule (the write fence's `ci_config?`): any
// component of the path, at any depth, that is a CI directory name or CI file
// name, `jenkinsfile` or `jenkinsfile.*`, or that ends in `.gitlab-ci.yml` or
// `.gitlab-ci.yaml`, compared case-folded, after a leading `./` is dropped. A
// name that merely contains a CI name (`.github-old/`, `my.circleci/`) is not a
// match. The platform's list is the source; change both together.

const CI_DIRS = new Set([
  '.github',
  '.circleci',
  '.buildkite',
  '.gitlab',
  '.woodpecker',
  '.gitea',
  '.forgejo',
  '.semaphore',
  '.tekton',
  '.azure-pipelines',
]);

const CI_FILES = new Set([
  '.gitlab-ci.yml',
  '.gitlab-ci.yaml',
  '.travis.yml',
  'azure-pipelines.yml',
  'azure-pipelines.yaml',
  'bitbucket-pipelines.yml',
  '.drone.yml',
  '.drone.yaml',
  '.drone.jsonnet',
  '.drone.star',
  '.woodpecker.yml',
  '.woodpecker.yaml',
  'buildkite.yml',
  'buildkite.yaml',
  'buildkite.json',
  'appveyor.yml',
  '.appveyor.yml',
  '.cirrus.yml',
  '.cirrus.star',
  'cloudbuild.yaml',
  'cloudbuild.yml',
  'cloudbuild.json',
  'buildspec.yml',
  'buildspec.yaml',
  'bitrise.yml',
  'codemagic.yaml',
  'codeowners',
]);

function ciName(name) {
  return (
    CI_DIRS.has(name) ||
    CI_FILES.has(name) ||
    name === 'jenkinsfile' ||
    name.startsWith('jenkinsfile.') ||
    name.endsWith('.gitlab-ci.yml') ||
    name.endsWith('.gitlab-ci.yaml')
  );
}

function isCiConfig(filePath) {
  if (typeof filePath !== 'string') return false;
  return filePath
    .replace(/^(\.\/)+/, '')
    .split('/')
    .some((component) => ciName(component.toLowerCase()));
}

// The changed paths that are CI configuration, in the order given.
function ciPaths(paths) {
  return (Array.isArray(paths) ? paths : []).filter(isCiConfig);
}

module.exports = { isCiConfig, ciPaths };
