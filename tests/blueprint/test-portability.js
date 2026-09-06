const fs = require('node:fs');

function readText(filePath) {
  // Ignore checkout line endings without changing indentation or blank lines.
  return fs.readFileSync(filePath, 'utf8').replace(/\r\n?/g, '\n');
}

function pythonExecutable(env = process.env, platform = process.platform) {
  return env.PYTHON || (platform === 'win32' ? 'python' : 'python3');
}

module.exports = { readText, pythonExecutable };
