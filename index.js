var data = require('sdk/self').data;
var pageMod = require('sdk/page-mod');

pageMod.PageMod({
  include: /file:\/\/.*\/.*\.shtml(\?.*|#.*)?/,
  contentScriptWhen: 'ready',
  contentScriptFile: data.url('content_script.js'),
  //attachTo: [ 'existing', 'top', 'frames' ]
});
