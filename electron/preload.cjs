const {contextBridge,ipcRenderer}=require('electron');
const methods=['bootstrap','sync','submit','comment','openExternal','saveSettings','login','logout','cancelLogin','getComments','propose','updateLocal','exportLocal','saveDocument','deleteDocument','refreshAccount'];
const bridge=Object.fromEntries(methods.map(name=>[name,(...args)=>ipcRenderer.invoke(name,...args)]));
bridge.onAuthProgress=callback=>{const handler=(_event,data)=>callback(data);ipcRenderer.on('auth-progress',handler);return ()=>ipcRenderer.removeListener('auth-progress',handler);};
contextBridge.exposeInMainWorld('notebook',bridge);
