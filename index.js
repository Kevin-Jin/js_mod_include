var data = require('sdk/self').data;
var pageMod = require('sdk/page-mod');

pageMod.PageMod({
  include: /file:\/\/.*\/.*\.shtml(\?.*|#.*)?/,
  contentScriptWhen: 'start',
  contentScriptFile: [ data.url('utf8.js'), data.url('content_script.js') ],
  //attachTo: [ 'existing', 'top', 'frames' ]
});
