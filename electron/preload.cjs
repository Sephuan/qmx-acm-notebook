const {contextBridge,ipcRenderer}=require('electron');
const methods=['plannerAction','bindPlatform','refreshPlatform','unbindPlatform','getContests','bootstrap','sync','submit','comment','openExternal','openAuthUrl','formatCode','saveSettings','login','logout','cancelLogin','getComments','propose','updateLocal','exportLocal','saveDocument','saveAlgorithmNote','deleteDocument','deleteIssue','refreshAccount','checkStartupUpdates','checkForUpdates','downloadUpdate','installUpdate','getTagCatalog','requestTag','getTagReview','reviewTag'];
const bridge=Object.fromEntries(methods.map(name=>[name,(...args)=>ipcRenderer.invoke(name,...args)]));
bridge.onAuthProgress=callback=>{const handler=(_event,data)=>callback(data);ipcRenderer.on('auth-progress',handler);return ()=>ipcRenderer.removeListener('auth-progress',handler);};
bridge.onUpdateProgress=callback=>{const handler=(_event,data)=>callback(data);ipcRenderer.on('update-progress',handler);return ()=>ipcRenderer.removeListener('update-progress',handler);};
contextBridge.exposeInMainWorld('notebook',bridge);
