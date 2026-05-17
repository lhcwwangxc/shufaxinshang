// 墨韵书斋 - app.js (完整版：含 Word 导出)
// JS 执行标记
(function(){
  var el = document.getElementById('jsStatus');
  if(el) el.textContent = 'JS OK';
})();

// ═══════════════
//  IndexedDB 封装
// ═══════════════
var DB = {
  name: 'CalligraphyApp',
  ver: 1,
  _db: null,

  open: function() {
    var self = this;
    if(self._db) return Promise.resolve(self._db);
    return new Promise(function(resolve, reject){
      var req = indexedDB.open(self.name, self.ver);
      req.onupgradeneeded = function(e) {
        var db = e.target.result;
        if(!db.objectStoreNames.contains('collections')) {
          db.createObjectStore('collections', { keyPath:'id', autoIncrement:true });
        }
        if(!db.objectStoreNames.contains('works')) {
          var ws = db.createObjectStore('works', { keyPath:'id', autoIncrement:true });
          ws.createIndex('collectionId', 'collectionId', { unique:false });
        }
        if(!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings', { keyPath:'key' });
        }
      };
      req.onsuccess = function(e) { self._db = e.target.result; resolve(self._db); };
      req.onerror = function(e) { reject(e.target.error); };
    });
  },

  addCollection: function(col) {
    var self = this;
    col.createdAt = Date.now();
    return self.open().then(function(db){
      return new Promise(function(resolve, reject){
        var tx = db.transaction('collections', 'readwrite');
        var req = tx.objectStore('collections').add(col);
        req.onsuccess = function(){ resolve(req.result); };
        req.onerror = function(e){ reject(e.target.error); };
      });
    });
  },

  getAllCollections: function() {
    var self = this;
    return self.open().then(function(db){
      return new Promise(function(resolve, reject){
        var req = db.transaction('collections','readonly').objectStore('collections').getAll();
        req.onsuccess = function(){ resolve(req.result || []); };
        req.onerror = function(e){ reject(e.target.error); };
      });
    });
  },

  deleteCollection: function(id) {
    var self = this;
    return self.open().then(function(db){
      return new Promise(function(resolve, reject){
        var tx = db.transaction(['collections','works'], 'readwrite');
        tx.objectStore('collections').delete(id);
        var idx = tx.objectStore('works').index('collectionId');
        idx.openCursor(IDBKeyRange.only(id)).onsuccess = function(e){
          var cursor = e.target.result;
          if(cursor){ cursor.delete(); cursor.continue(); }
        };
        tx.oncomplete = function(){ resolve(); };
        tx.onerror = function(e){ reject(e.target.error); };
      });
    });
  },

  addWork: function(work) {
    var self = this;
    work.createdAt = work.createdAt || Date.now();
    return self.open().then(function(db){
      return new Promise(function(resolve, reject){
        var req = db.transaction('works','readwrite').objectStore('works').add(work);
        req.onsuccess = function(){ resolve(req.result); };
        req.onerror = function(e){ reject(e.target.error); };
      });
    });
  },

  getWorksByCollection: function(collectionId) {
    var self = this;
    return self.open().then(function(db){
      return new Promise(function(resolve, reject){
        var req = db.transaction('works','readonly').objectStore('works').index('collectionId').getAll(collectionId);
        req.onsuccess = function(){ resolve(req.result || []); };
        req.onerror = function(e){ reject(e.target.error); };
      });
    });
  },

  getSetting: function(key) {
    var self = this;
    return self.open().then(function(db){
      return new Promise(function(resolve, reject){
        var req = db.transaction('settings','readonly').objectStore('settings').get(key);
        req.onsuccess = function(){ resolve(req.result ? req.result.value : null); };
        req.onerror = function(e){ reject(e.target.error); };
      });
    });
  },

  setSetting: function(key, value) {
    var self = this;
    return self.open().then(function(db){
      return new Promise(function(resolve, reject){
        var req = db.transaction('settings','readwrite').objectStore('settings').put({ key:key, value:value });
        req.onsuccess = function(){ resolve(); };
        req.onerror = function(e){ reject(e.target.error); };
      });
    });
  }
};

// ═══════════════
//  AI 调用
// ═══════════════
var AI = {
  call: function(systemPrompt, userContent, temperature) {
    return Promise.all([
      DB.getSetting('apiUrl'),
      DB.getSetting('apiKey'),
      DB.getSetting('apiModel')
    ]).then(function(vals){
      var url = vals[0] || 'https://api.deepseek.com/v1/chat/completions';
      var key = vals[1];
      var model = vals[2] || 'deepseek-chat';
      if(!key) throw new Error('请先在设置页填写 API Key');
      return fetch(url, {
        method:'POST',
        headers:{'Content-Type':'application/json','Authorization':'Bearer '+key},
        body: JSON.stringify({
          model:model,
          messages:[
            {role:'system',content:systemPrompt},
            {role:'user',content:userContent}
          ],
          temperature:temperature||0.7,
          max_tokens:2000
        })
      }).then(function(r){
        if(!r.ok) throw new Error('API 错误: '+r.status);
        return r.json();
      }).then(function(data){
        if(data.choices && data.choices[0] && data.choices[0].message) {
          return data.choices[0].message.content.trim();
        }
        throw new Error('API 返回格式异常');
      });
    });
  }
};

// ═══════════════
//  Word 导出（Docx 对象）
// ═══════════════
var Docx = {
  escXml: function(s) {
    return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  },

  base64ToBin: function(b64) {
    var raw = atob(b64), arr = new Uint8Array(raw.length);
    for(var i=0;i<raw.length;i++) arr[i]=raw.charCodeAt(i);
    return arr;
  },

  gen: function(works, collectionName) {
    if(typeof JSZip==='undefined') return Promise.reject(new Error('JSZip 未加载'));
    var z=new JSZip(), body='', rels=[], rIdx=1;

    for(var i=0;i<works.length;i++){
      var w=works[i];
      // 图片页
      if(w.imageData && w.imageType){
        var ext=(w.imageType==='image/png')?'png':'jpeg';
        var mname='image'+(i+1)+'.'+ext;
        z.folder('word/media').file(mname, w.imageData, {base64:true});
        var rid='rId'+(++rIdx);
        rels.push('<Relationship Id="'+rid+'" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/'+mname+'"/>');
        var PX2EMU=9525;
        var iw=(w.imageWidth||800)*PX2EMU, ih=(w.imageHeight||600)*PX2EMU;
        var mw=5400000,mh=9000000,sc=Math.min(mw/iw,mh/ih,1);
        var cx=Math.round(iw*sc),cy=Math.round(ih*sc);
        // 浮于文字上方，水平居中
        body+='<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:drawing><wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="251658240" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1"><wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="column"><wp:align>center</wp:align></wp:positionH><wp:positionV relativeFrom="paragraph"><wp:posOffset>0</wp:posOffset></wp:positionV><wp:extent cx="'+cx+'" cy="'+cy+'"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapNone/><wp:docPr id="'+(i+1)+'" name="img'+(i+1)+'"/><wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="'+mname+'"/><pic:cNvPicPr><a:picLocks noChangeAspect="1"/></pic:cNvPicPr></pic:nvPicPr><pic:blipFill><a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="'+rid+'"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="'+cx+'" cy="'+cy+'"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:anchor></w:drawing></w:r></w:p>';
      }
      body+='<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
      // 文字页（靠左）
      body+='<w:p><w:pPr><w:jc w:val="left"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="微软雅黑" w:hAnsi="微软雅黑" w:eastAsia="微软雅黑"/><w:b/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr><w:t>【原文】</w:t></w:r></w:p>';
      body+='<w:p><w:pPr><w:jc w:val="both"/><w:ind w:firstLine="480"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="微软雅黑" w:hAnsi="微软雅黑" w:eastAsia="微软雅黑"/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr><w:t xml:space="preserve">'+Docx.escXml(w.originalText||'')+'</w:t></w:r></w:p>';
      body+='<w:p><w:pPr><w:jc w:val="left"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="微软雅黑" w:hAnsi="微软雅黑" w:eastAsia="微软雅黑"/><w:b/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr><w:t>【书法赏析】</w:t></w:r></w:p>';
      body+='<w:p><w:pPr><w:jc w:val="both"/><w:ind w:firstLine="480"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="微软雅黑" w:hAnsi="微软雅黑" w:eastAsia="微软雅黑"/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr><w:t xml:space="preserve">'+Docx.escXml(w.analysis||'')+'</w:t></w:r></w:p>';
      if(i<works.length-1) body+='<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
    }

    // 关系文件
    z.folder('word/_rels').file('document.xml.rels',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n'+
      rels.join('\n')+'\n</Relationships>');

    // Content Types
    var ct='<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n'+
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n'+
      '<Default Extension="xml" ContentType="application/xml"/>\n'+
      '<Default Extension="jpeg" ContentType="image/jpeg"/>\n'+
      '<Default Extension="png" ContentType="image/png"/>\n'+
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>\n'+
      '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>\n'+
      '</Types>';
    z.file('[Content_Types].xml', ct);

    // 包级关系
    z.folder('_rels').file('.rels',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n'+
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>\n'+
      '</Relationships>');

    // 文档主体
    z.folder('word').file('document.xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'+
      '<w:document xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" '+
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '+
      'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '+
      'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" '+
      'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '+
      'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" '+
      'mc:Ignorable="wp14">\n'+
      '<w:body>'+body+
      '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1800" w:bottom="1440" w:left="1800"/><w:cols w:space="425" w:num="1"/></w:sectPr>'+
      '</w:body></w:document>');

    // 样式
    z.folder('word').file('styles.xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'+
      '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">\n'+
      '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="微软雅黑" w:hAnsi="微软雅黑" w:eastAsia="微软雅黑"/><w:sz w:val="24"/></w:rPr></w:rPrDefault></w:docDefaults>\n'+
      '</w:styles>');

    z.folder('word').file('settings.xml','<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"></w:settings>');

    var fname=(collectionName||'书法作品集')+'.docx';
    return z.generateAsync({type:'blob'}).then(function(blob){
      var a=document.createElement('a');
      a.href=URL.createObjectURL(blob);
      a.download=fname;
      a.click();
      URL.revokeObjectURL(a.href);
    });
  }
};

// ═══════════════
//  主应用
// ═══════════════
var App = {
  currentImageData: null,
  currentImageType: null,
  currentImageWidth: null,
  currentImageHeight: null,
  currentCollectionId: null,

  switchPage: function(page) {
    document.querySelectorAll('nav a').forEach(function(a){
      a.classList.toggle('active', a.getAttribute('data-page') === page);
    });
    document.querySelectorAll('.page').forEach(function(p){
      p.classList.toggle('active', p.id === 'page' + page.charAt(0).toUpperCase() + page.slice(1));
    });
  },

  handleImage: function(file) {
    if(!file || !file.type || !file.type.startsWith('image/')) {
      App.toast('⚠️ 请选择图片文件');
      return;
    }
    var reader = new FileReader();
    reader.onload = function(e) {
      var dataUrl = e.target.result;
      var base64 = dataUrl.split(',')[1];
      var img = new Image();
      img.onload = function() {
        App.currentImageData = base64;
        App.currentImageType = file.type;
        App.currentImageWidth = img.naturalWidth;
        App.currentImageHeight = img.naturalHeight;
        var area = document.getElementById('uploadArea');
        area.classList.add('has-image');
        area.innerHTML = '<img class="preview-img" src="'+dataUrl+'">';
        App.toast('✅ 图片已加载');
      };
      img.src = dataUrl;
    };
    reader.readAsDataURL(file);
  },

  aiAnalyze: function() {
    var content = (document.getElementById('originalText').value||'').trim();
    if(!content){ App.toast('⚠️ 请先输入书写内容原文'); return; }
    var btn = document.getElementById('btnAnalyze');
    btn.disabled = true;
    btn.innerHTML = '<span class="loading"></span> 赏析中...';
    AI.call(
      '你是一位书法鉴赏专家。请根据提供的书法作品原文，从笔法、结体、章法、墨法、取法与风格等维度进行深入赏析，300-500字，语言优美有深度，最后一段以"整体来看"开头。不要加标题。',
      content, 0.7
    ).then(function(analysis){
      document.getElementById('analysisText').textContent = analysis;
      document.getElementById('analysisBox').classList.add('show');
      App.toast('✅ 书法赏析完成');
    }).catch(function(e){
      App.toast('❌ '+(e.message||'赏析失败'));
    }).finally(function(){
      btn.disabled = false;
      btn.textContent = '🔍 AI 书法赏析';
    });
  },

  save: function() {
    var collectionId = parseInt(document.getElementById('collectionSelect').value);
    if(!collectionId){ App.toast('⚠️ 请先选择作品集'); return; }
    var originalText = (document.getElementById('originalText').value||'').trim();
    if(!originalText){ App.toast('⚠️ 请输入书写内容原文'); return; }
    if(!App.currentImageData){ App.toast('⚠️ 请上传书法作品图片'); return; }
    var analysis = (document.getElementById('analysisText').textContent||'').trim();
    App.toast('💾 保存中...');
    DB.addWork({
      collectionId:collectionId,
      originalText:originalText,
      analysis:analysis,
      imageData:App.currentImageData,
      imageType:App.currentImageType,
      imageWidth:App.currentImageWidth,
      imageHeight:App.currentImageHeight
    }).then(function(){
      App.toast('✅ 保存成功！');
      document.getElementById('originalText').value = '';
      document.getElementById('analysisText').textContent = '';
      document.getElementById('analysisBox').classList.remove('show');
      App.currentImageData = null;
      App.currentImageType = null;
      var area = document.getElementById('uploadArea');
      area.classList.remove('has-image');
      area.innerHTML = '<div class="upload-icon">🖼️</div><div class="upload-text">点击或拖拽上传书法作品图片</div>';
    }).catch(function(e){
      App.toast('❌ 保存失败: '+(e.message||''));
    });
  },

  showNewCollection: function() {
    var name = prompt('请输入作品集名称：');
    if(!name) return;
    App.toast('💾 创建中...');
    DB.addCollection({name:name.trim()}).then(function(){
      App.toast('✅ 作品集已创建');
      App.loadCollections();
      App.loadCollectionSelect();
    }).catch(function(e){
      App.toast('❌ 创建失败: '+(e.message||''));
    });
  },

  loadCollections: function() {
    DB.getAllCollections().then(function(list){
      var container = document.getElementById('collectionList');
      var empty = document.getElementById('emptyCollections');
      if(!list || list.length===0){
        container.innerHTML = '';
        empty.style.display = '';
        return;
      }
      empty.style.display = 'none';
      var html = '';
      list.forEach(function(col){
        html += '<div class="collection-item" data-id="'+col.id+'">' +
          '<div class="collection-name">'+App.escHtml(col.name)+'</div>' +
          '<div class="collection-info">创建于 '+new Date(col.createdAt).toLocaleDateString('zh-CN')+'</div>' +
          '<div class="collection-actions">' +
            '<button class="btn btn-outline btn-sm" onclick="App.openCollection('+col.id+',\''+App.escAttr(col.name)+'\')">打开</button>' +
            '<button class="btn btn-danger btn-sm" onclick="App.deleteCollectionConfirm('+col.id+',\''+App.escAttr(col.name)+'\')">删除</button>' +
          '</div></div>';
      });
      container.innerHTML = html;
    }).catch(function(e){
      console.error('loadCollections error:', e);
    });
  },

  loadCollectionSelect: function() {
    DB.getAllCollections().then(function(list){
      var sel = document.getElementById('collectionSelect');
      var html = '<option value="">-- 请选择作品集 --</option>';
      (list||[]).forEach(function(col){
        html += '<option value="'+col.id+'">'+App.escHtml(col.name)+'</option>';
      });
      sel.innerHTML = html;
    });
  },

  openCollection: function(id, name) {
    App.currentCollectionId = id;
    document.getElementById('collectionList').style.display = 'none';
    document.getElementById('emptyCollections').style.display = 'none';
    document.getElementById('collectionDetail').style.display = '';
    document.getElementById('detailName').textContent = name||'';
    App.loadWorks(id);
  },

  loadWorks: function(collectionId) {
    DB.getWorksByCollection(collectionId).then(function(list){
      var container = document.getElementById('workList');
      var empty = document.getElementById('emptyWorks');
      if(!list || list.length===0){
        container.innerHTML = '';
        empty.style.display = '';
        return;
      }
      empty.style.display = 'none';
      var html = '';
      list.forEach(function(w){
        var preview = '';
        if(w.imageData){
          preview = '<img class="work-thumb" src="data:'+(w.imageType||'image/jpeg')+';base64,'+w.imageData+'">';
        }
        html += '<div class="work-item" data-id="'+w.id+'">' +
          preview +
          '<div class="work-info">' +
            '<div class="work-title">'+App.escHtml((w.originalText||'').substring(0,50))+'</div>' +
            '<div class="work-date">'+new Date(w.createdAt).toLocaleString('zh-CN')+'</div>' +
          '</div></div>';
      });
      container.innerHTML = html;
    });
  },

  deleteCollectionConfirm: function(id, name) {
    if(!confirm('确定要删除作品集「'+name+'」吗？\n该作品集下的所有作品也会被删除！')) return;
    DB.deleteCollection(id).then(function(){
      App.toast('✅ 已删除');
      App.loadCollections();
      App.loadCollectionSelect();
    }).catch(function(e){
      App.toast('❌ 删除失败: '+(e.message||''));
    });
  },

  exportCollection: function() {
    var collectionId = App.currentCollectionId;
    if(!collectionId){ App.toast('⚠️ 请先打开一个作品集'); return; }
    App.toast('📄 生成 Word 中...');
    DB.getAllCollections().then(function(cols){
      var col = cols.find(function(c){ return c.id === collectionId; });
      var colName = col ? col.name : '书法作品集';
      return DB.getWorksByCollection(collectionId).then(function(works){
        if(!works || works.length===0){ App.toast('⚠️ 作品集是空的'); return null; }
        return Docx.gen(works, colName);
      });
    }).then(function(){
      if(arguments[0]!==null) App.toast('✅ Word 导出成功');
    }).catch(function(e){
      App.toast('❌ 导出失败: '+(e.message||''));
    });
  },

  exportJSON: function() {
    var collectionId = App.currentCollectionId;
    if(!collectionId){ App.toast('⚠️ 请先打开一个作品集'); return; }
    App.toast('📦 导出 JSON 中...');
    DB.getWorksByCollection(collectionId).then(function(works){
      var data = works.map(function(w){ return { originalText:w.originalText||'', analysis:w.analysis||'', imageData:w.imageData||null, imageType:w.imageType||null, imageWidth:w.imageWidth||null, imageHeight:w.imageHeight||null, createdAt:w.createdAt }; });
      var blob = new Blob([JSON.stringify(data, null, 2)], {type:'application/json'});
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'calligraphy_backup_' + new Date().toISOString().slice(0,10) + '.json';
      a.click();
      URL.revokeObjectURL(a.href);
      App.toast('✅ JSON 导出成功');
    }).catch(function(e){
      App.toast('❌ 导出失败: '+(e.message||''));
    });
  },

  importJSON: function() {
    var fi = document.getElementById('jsonFileInput');
    if(fi) fi.click();
  },

  handleJSONImport: function(e) {
    var file = e.target.files ? e.target.files[0] : null;
    if(!file) return;
    var reader = new FileReader();
    reader.onload = function(ev) {
      try {
        var data = JSON.parse(ev.target.result);
        if(!Array.isArray(data)) throw new Error('JSON 格式错误');
        var collectionId = App.currentCollectionId;
        if(!collectionId){ App.toast('⚠️ 请先打开一个作品集'); return; }
        App.toast('📥 导入中...');
        var added = 0;
        var promise = Promise.resolve();
        data.forEach(function(item){
          promise = promise.then(function(){ 
            return DB.addWork({ collectionId:collectionId, originalText:item.originalText||'', analysis:item.analysis||'', imageData:item.imageData||null, imageType:item.imageType||null, imageWidth:item.imageWidth||null, imageHeight:item.imageHeight||null, createdAt:item.createdAt||Date.now() }).then(function(){ added++; });
          });
        });
        promise.then(function(){
          App.toast('✅ 导入完成，共 '+added+' 条');
          App.loadWorks(collectionId);
        }).catch(function(err){
          App.toast('❌ 导入失败: '+(err.message||''));
        });
      } catch(err) {
        App.toast('❌ JSON 解析失败: '+(err.message||''));
      }
    };
    reader.readAsText(file);
  },

  loadSettings: function() {
    try {
      DB.getSetting('apiUrl').then(function(v){ if(v) document.getElementById('apiUrl').value = v; });
      DB.getSetting('apiKey').then(function(v){ if(v) document.getElementById('apiKey').value = v; });
      DB.getSetting('apiModel').then(function(v){ if(v) document.getElementById('apiModel').value = v; });
    } catch(e){ console.error('loadSettings error:', e); }
  },

  saveSettings: function() {
    try {
      DB.setSetting('apiUrl', (document.getElementById('apiUrl').value||'').trim());
      DB.setSetting('apiKey', (document.getElementById('apiKey').value||'').trim());
      DB.setSetting('apiModel', (document.getElementById('apiModel').value||'').trim());
    } catch(e){ console.error('saveSettings error:', e); }
  },

  testAPI: function() {
    App.saveSettings();
    var resultEl = document.getElementById('apiResult');
    resultEl.textContent = '测试中...';
    AI.call('你是书法专家','请回复"连接成功"',0).then(function(){
      resultEl.textContent = '✅ 连接正常！';
      App.toast('✅ API 连接正常');
    }).catch(function(e){
      resultEl.textContent = '❌ 失败: '+(e.message||'连接失败').substring(0,60);
      App.toast('❌ '+(e.message||'连接失败'));
    });
  },

  escHtml: function(s) {
    var d = document.createElement('div');
    d.textContent = s||'';
    return d.innerHTML;
  },

  escAttr: function(s) {
    return (s||'').replace(/'/g,"\\'").replace(/"/g,'&quot;');
  },

  toast: function(msg) {
    var el = document.getElementById('toast');
    if(!el) return;
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(el._timer);
    el._timer = setTimeout(function(){ el.classList.remove('show'); },2500);
  }
};

// ═══════════════
//  初始化
// ═══════════════
function initApp() {
  try {
    // 导航
    document.querySelectorAll('nav a').forEach(function(a){
      a.addEventListener('click', function(e){
        e.preventDefault();
        var page = this.getAttribute('data-page');
        if(page) App.switchPage(page);
      });
    });

    // 图片上传区域
    var uploadArea = document.getElementById('uploadArea');
    if(uploadArea) {
      uploadArea.addEventListener('click', function(){
        var input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        input.onchange = function(e){ App.handleImage(e.target.files[0]); };
        input.click();
      });
    }

    // AI 赏析按钮
    var btnAnalyze = document.getElementById('btnAnalyze');
    if(btnAnalyze) {
      btnAnalyze.addEventListener('click', function(){ App.aiAnalyze(); });
    }

    // 保存按钮
    var btnSave = document.getElementById('btnSave');
    if(btnSave) {
      btnSave.addEventListener('click', function(){ App.save(); });
    }

    // 新建作品集按钮
    var btnNew = document.getElementById('btnNewCollection');
    if(btnNew) {
      btnNew.addEventListener('click', function(){ App.showNewCollection(); });
    }

    // 返回列表按钮
    var btnBack = document.getElementById('btnBackToList');
    if(btnBack) {
      btnBack.addEventListener('click', function(){
        document.getElementById('collectionDetail').style.display = 'none';
        document.getElementById('collectionList').style.display = '';
        App.loadCollections();
      });
    }

    // 导出 Word 按钮
    var btnExport = document.getElementById('btnExportWord');
    if(btnExport) {
      btnExport.disabled = false;
      btnExport.textContent = '📄 导出 Word';
      btnExport.addEventListener('click', function(){ App.exportCollection(); });
    }

    // 导出 JSON 按钮
    var btnExportJSON = document.getElementById('btnExportJSON');
    if(btnExportJSON) {
      btnExportJSON.addEventListener('click', function(){ App.exportJSON(); });
    }

    // 导入 JSON 按钮
    var btnImportJSON = document.getElementById('btnImportJSON');
    if(btnImportJSON) {
      btnImportJSON.addEventListener('click', function(){ App.importJSON(); });
    }

    // JSON 文件输入
    var jsonFileInput = document.getElementById('jsonFileInput');
    if(jsonFileInput) {
      jsonFileInput.addEventListener('change', function(e){ App.handleJSONImport(e); });
    }

    // 设置自动保存
    ['apiUrl','apiModel','apiKey'].forEach(function(id){
      var el = document.getElementById(id);
      if(el) el.addEventListener('blur', function(){ App.saveSettings(); });
    });

    // 加载设置
    App.loadSettings();

    // 加载作品集
    App.loadCollections();
    App.loadCollectionSelect();

    console.log('App initialized successfully');
  } catch(err) {
    console.error('App init error:', err);
  }
}

// 启动
if(document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}

// Service Worker
if('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(function(){});
}
