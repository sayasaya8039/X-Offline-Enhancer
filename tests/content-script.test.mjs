import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadFunctionFromContentScript(functionName) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'content_script.js'), 'utf8');
  const pattern = new RegExp(`function ${functionName}\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}`);
  const match = source.match(pattern);
  if (!match) {
    throw new Error(`Function not found in content_script.js: ${functionName}`);
  }

  const context = {};
  vm.runInNewContext(`${match[0]}; this.${functionName} = ${functionName};`, context);
  return context[functionName];
}

test('extractTweetId prefers the article permalink over quoted tweet links', () => {
  const extractTweetId = loadFunctionFromContentScript('extractTweetId');

  const ownPermalink = { href: 'https://x.com/alice/status/2222222222222222222' };
  const quotedPermalink = { href: 'https://x.com/bob/status/1111111111111111111' };
  const timeEl = {
    closest(selector) {
      assert.equal(selector, 'a[href*="/status/"]');
      return ownPermalink;
    }
  };

  const articleEl = {
    querySelector(selector) {
      assert.equal(selector, 'time');
      return timeEl;
    },
    querySelectorAll(selector) {
      assert.equal(selector, 'a[href*="/status/"]');
      return [quotedPermalink, ownPermalink];
    }
  };

  assert.equal(extractTweetId(articleEl), '2222222222222222222');
});

test('extractTweetId falls back to the first status link when no permalink time exists', () => {
  const extractTweetId = loadFunctionFromContentScript('extractTweetId');

  const articleEl = {
    querySelector(selector) {
      assert.equal(selector, 'time');
      return null;
    },
    querySelectorAll(selector) {
      assert.equal(selector, 'a[href*="/status/"]');
      return [
        { href: 'https://x.com/alice/status/3333333333333333333' },
        { href: 'https://x.com/alice/status/4444444444444444444' }
      ];
    }
  };

  assert.equal(extractTweetId(articleEl), '3333333333333333333');
});
