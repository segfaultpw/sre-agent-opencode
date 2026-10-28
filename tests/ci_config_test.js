'use strict';

// Unit tests for runner/ci_config.js: which changed paths are CI configuration.
// The table is the platform's rule (its write fence's ci_config?), so a case
// added there belongs here too.
const assert = require('node:assert');
const { isCiConfig, ciPaths } = require('../runner/ci_config.js');

const yes = [
  '.circleci/config.yml',
  './.circleci/config.yml',
  '.CircleCI/config.yml',
  'sub/dir/.buildkite/pipeline.yml',
  '.gitlab/ci/build.yml',
  '.gitlab-ci.yml',
  'services/api/.gitlab-ci.yaml',
  'team.gitlab-ci.yml',
  '.travis.yml',
  'azure-pipelines.yml',
  'bitbucket-pipelines.yml',
  'cloudbuild.yaml',
  'buildspec.yml',
  'Jenkinsfile',
  'Jenkinsfile.release',
  'deploy/jenkinsfile',
  'CODEOWNERS',
  '.github/workflows/ci.yml',
  '.tekton/pipeline.yaml',
  '.azure-pipelines/steps.yml',
  '.drone.yml',
  '.cirrus.star',
  'codemagic.yaml',
];

const no = [
  'README.md',
  'src/index.js',
  '.github-old/ci.yml',
  'my.circleci/config.yml',
  'circleci/config.yml',
  'docs/jenkinsfile-notes.md',
  'Jenkinsfiles/readme',
  'lib/travis.yml.example',
  '',
  'a/b/c.tf',
];

for (const path of yes) assert.strictEqual(isCiConfig(path), true, `${path} is CI configuration`);
for (const path of no) assert.strictEqual(isCiConfig(path), false, `${path} is not CI configuration`);
for (const value of [null, undefined, 7, {}, ['.circleci/config.yml']]) {
  assert.strictEqual(isCiConfig(value), false, `${JSON.stringify(value)} is not a path`);
}

assert.deepStrictEqual(ciPaths(['README.md', '.circleci/config.yml', 'src/a.js', 'Jenkinsfile']), [
  '.circleci/config.yml',
  'Jenkinsfile',
]);
assert.deepStrictEqual(ciPaths(['README.md']), []);
assert.deepStrictEqual(ciPaths(undefined), []);
assert.deepStrictEqual(ciPaths('.circleci/config.yml'), []);

console.log(`ok   ${yes.length} CI paths and ${no.length} other paths are classified as the platform classifies them`);
