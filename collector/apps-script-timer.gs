// Google Apps Script (script.google.com, Josh's Google account): the outside timer for the auction collector.
// GitHub does not run scheduled workflows in this repo (tested 2026-11-12: not even a 5-minute probe ran), so a
// time-driven trigger here calls startCollector every 30 minutes, which asks GitHub to run collect.yml now.
// Script property GITHUB_TOKEN: a fine-grained GitHub token for jckim014/wow-forever-tool only, Actions: Read and
// write (separate from the PC sync's token, so either can be revoked alone). A failed call throws, and Apps Script
// emails Josh (trigger set to "Notify me immediately").
function startCollector() {
  const token = PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN');
  if (!token) throw new Error('No GITHUB_TOKEN in the script properties');
  const res = UrlFetchApp.fetch(
    'https://api.github.com/repos/jckim014/wow-forever-tool/actions/workflows/collect.yml/dispatches',
    {
      method: 'post',
      contentType: 'application/json',
      headers: {
        Authorization: 'Bearer ' + token,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      payload: JSON.stringify({ ref: 'main' }),
      muteHttpExceptions: true,
    },
  );
  if (res.getResponseCode() !== 204) {
    throw new Error('GitHub answered HTTP ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 300));
  }
}
