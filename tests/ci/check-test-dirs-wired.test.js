const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { readText, pythonExecutable } = require('../blueprint/test-portability.js');

const repoRoot = path.join(__dirname, '../..');
const CHECKER = path.join('scripts', 'ci', 'check-test-dirs-wired.py');
const WORKFLOW = path.join('.github', 'workflows', 'python-pytest.yml');
const GOVERNED_ACTIONS_TESTS = 'skills/threadlight-governed-actions/tests';
const GOVERNED_ACTIONS_STEP = /- name: Test threadlight-governed-actions\n\s+run: python -m pytest skills\/threadlight-governed-actions\/tests -q/;

function runChecker(root) {
  return spawnSync(pythonExecutable(), [path.join(root, CHECKER)], {
    cwd: root,
    encoding: 'utf8',
  });
}

// The checker resolves its own repository root from __file__, so a faithful
// negative case needs a real directory tree rather than a monkeypatched
// constant: scripts/ci/<checker>, the workflow it reads, and the suites it
// globs. The tree is built under this test directory (never a shared temp
// dir) and always removed again, so a failed assertion cannot leave a stray
// skills/ tree behind for the real checker or pytest to discover.
function withFixtureRoot(mutateWorkflow, body) {
  const fixtureRoot = fs.mkdtempSync(path.join(__dirname, '.tmp-wired-'));
  try {
    fs.mkdirSync(path.join(fixtureRoot, 'scripts', 'ci'), { recursive: true });
    fs.mkdirSync(path.join(fixtureRoot, '.github', 'workflows'), { recursive: true });
    fs.copyFileSync(path.join(repoRoot, CHECKER), path.join(fixtureRoot, CHECKER));

    for (const suite of ['threadlight-governed-actions', 'threadlight-design']) {
      const suiteDir = path.join(fixtureRoot, 'skills', suite, 'tests');
      fs.mkdirSync(suiteDir, { recursive: true });
      fs.writeFileSync(path.join(suiteDir, 'test_fixture.py'), 'def test_fixture():\n    assert True\n');
    }

    const workflow = mutateWorkflow(readText(path.join(repoRoot, WORKFLOW)));
    fs.writeFileSync(path.join(fixtureRoot, WORKFLOW), workflow);

    body(fixtureRoot);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

test('the real repository has every pytest suite wired into python-pytest.yml', () => {
  const result = runChecker(repoRoot);
  assert.strictEqual(result.status, 0, `checker failed:\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, new RegExp(GOVERNED_ACTIONS_TESTS));
});

for (const [platform, defaultExecutable] of [['win32', 'python'], ['linux', 'python3'], ['darwin', 'python3']]) {
  test(`Python launcher uses ${defaultExecutable} by default on ${platform}`, () => {
    assert.strictEqual(pythonExecutable({}, platform), defaultExecutable);
    assert.strictEqual(pythonExecutable({ PYTHON: '' }, platform), defaultExecutable);
  });

  test(`Python launcher honors PYTHON over the ${platform} default`, () => {
    const executable = platform === 'win32'
      ? 'C:\\Custom Python\\python.exe'
      : '/opt/custom python/bin/python3';
    assert.strictEqual(pythonExecutable({ PYTHON: executable }, platform), executable);
  });
}

for (const [label, eol] of [['LF', '\n'], ['CRLF', '\r\n']]) {
  test(`omitting skills/threadlight-governed-actions/tests from a ${label} workflow fails the checker`, () => {
    withFixtureRoot(
      (workflow) =>
        workflow
          .split('\n')
          .filter((line) => !line.includes(GOVERNED_ACTIONS_TESTS))
          .join(eol),
      (fixtureRoot) => {
        const workflow = readText(path.join(fixtureRoot, WORKFLOW));
        assert.doesNotMatch(workflow, GOVERNED_ACTIONS_STEP);
        const result = runChecker(fixtureRoot);
        assert.strictEqual(result.status, 1, `expected exit 1, got ${result.status}\n${result.stdout}`);
        assert.match(result.stderr, new RegExp(`- ${GOVERNED_ACTIONS_TESTS}`));
      },
    );
  });

  test(`keeping the governed-actions step wired passes the ${label} fixture`, () => {
    withFixtureRoot(
      (workflow) => workflow.replace(/\n/g, eol),
      (fixtureRoot) => {
        const workflowPath = path.join(fixtureRoot, WORKFLOW);
        const raw = fs.readFileSync(workflowPath, 'utf8');
        assert.ok(raw.includes(eol), `fixture must contain ${label} line endings`);
        const workflow = readText(workflowPath);
        assert.strictEqual(workflow, raw.split(eol).join('\n'));
        assert.match(workflow, GOVERNED_ACTIONS_STEP);
        const result = runChecker(fixtureRoot);
        assert.strictEqual(
          result.status,
          0,
          `expected exit 0, got ${result.status}\n${result.stdout}\n${result.stderr}`,
        );
        assert.match(result.stdout, new RegExp(GOVERNED_ACTIONS_TESTS));
      },
    );
  });
}

test('python-pytest.yml runs the governed-actions suite as its own explicit step', () => {
  const workflow = readText(path.join(repoRoot, WORKFLOW));
  assert.match(
    workflow,
    GOVERNED_ACTIONS_STEP,
  );
});
