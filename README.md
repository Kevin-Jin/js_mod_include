# js_mod_include
Chrome and Firefox content script extension that parses SHTML files and supports #include, #set, #echo, and some basic #if directives using ap_expr syntax for compatibility with Apache's mod_include

To install the Firefox extension, you must have the Firefox Add-on SDK installed. To do this, you must install node.js and then run "# npm install jpm --global". Then run "$ jpm xpi" in the directory that contains package.json. Drag the resulting .xpi file into a Firefox window.

To install the Chrome extension, browse to "chrome://extensions" and then drag-and-drop the folder that contains the manifest.json into the Chrome window.
