const ejs = require('ejs');

// Simulate what renderTree outputs
const treeHtml = '<li class="folder-node" data-id="1"><div class="folder-row"><span class="toggle-placeholder"></span><span class="folder-icon">F</span><span class="folder-name">phim-hanh-dong</span><span class="folder-path-tag">phim-hanh-dong</span><div class="folder-actions"><button class="btn btn-xs btn-outline" onclick="openRename(1,\'phim-hanh-dong\')" title="Edit">E</button><form method="POST" action="/folders/delete/1" style="display:inline" onsubmit="return confirm(\'Delete?\')"><button type="submit" class="btn btn-xs btn-danger" title="Del">D</button></form></div></div></li>';

const fJson = JSON.stringify([{ id: 1, name: 'test', path: 'test/sub' }]);

console.log('--- Tree HTML ---');
console.log(treeHtml.substring(0, 100));
console.log('length:', treeHtml.length);

const template = '<div><%- treeHtml %></div><script>var fd = <%- fJson %>;</script>';
try {
    const result = ejs.render(template, { treeHtml, fJson });
    console.log('\n--- EJS result ---');
    console.log('length:', result.length);
    console.log('has folder-actions:', result.includes('folder-actions'));
    console.log('has openRename:', result.includes('openRename'));
    console.log('has fd:', result.includes('var fd ='));
    console.log('\nOutputHTML:\n', result);
} catch (e) {
    console.error('ERROR:', e.message);
}
