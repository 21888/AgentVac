// Normal packaged Electron native dialogs are completed with CUA on the dot desktop.
// This runner only instruments outcomes and exercises generated fixture data.
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
const project = process.cwd();
const out = path.join(project, 'docs/native-linux-next');
const ownedRoot = await fs.mkdtemp(path.join(project, '.qa/manual-'));
const profile = path.join(ownedRoot, 'profile');
const selectedRoot = path.join(ownedRoot, 'fixture');
const backupPath = path.join(ownedRoot, 'fixture-recovery.json');
await fs.mkdir(profile);
await fs.mkdir(path.join(selectedRoot, 'log'), { recursive: true });
await fs.writeFile(path.join(selectedRoot, 'log/codex-tui.log.1'), 'Generated native dialog fixture only.\n');
const result = { at: new Date().toISOString(), status: 'running', platform: process.platform, fixtureOnly: true, ownedRoot, profile, selectedRoot, backupPath, checks: [] };
const save = async () => fs.writeFile(path.join(out, 'manual-results.json'), JSON.stringify(result, null, 2));
const hash = async file => createHash('sha256').update(await fs.readFile(file)).digest('hex');
const exists = async file => fs.access(file).then(() => true, () => false);
const until = async (fn, label, timeout = 10*60*1000) => {
  const end = Date.now()+timeout;
  while (Date.now()<end) { const value=await fn(); if(value) return value; await new Promise(r=>setTimeout(r,250)); }
  throw new Error('Timed out '+label);
};
let app, page;
async function mark(stage) { result.stage=stage; await save(); console.log('NATIVE_STAGE',stage); }
async function nativeDialog(stage, type, trigger, expected) {
  await mark(stage);
  await trigger();
  const observedPath=path.join(ownedRoot,stage+'.observed.json');
  await until(()=>exists(observedPath),'CUA observed native dialog result '+stage);
  const observation=JSON.parse(await fs.readFile(observedPath,'utf8'));
  assert.equal(observation.stage,stage);assert.equal(observation.expected,expected);
  const row={type,observation,result:{canceled:expected===null,...(type==='save'?{filePath:expected}:{filePaths:expected===null?[]:[expected]})},nativeReturnObjectCaptured:false};
  await until(()=>page.getByRole('button',{name:/^(选择 Codex 目录|切换目录)$/}).isEnabled(),'renderer idle');
  result.checks.push({stage,realNativeDialog:true,...row});
  await page.screenshot({path:path.join(out,stage+'.png')});
  await save();
}
async function keyDialog(stage,kind,expected) {
  await page.getByTestId(kind+'-recovery-keys').click();
  assert.equal(await page.getByTestId('admin-risk-ack').isChecked(),false);
  assert.equal(await page.getByTestId('admin-confirm').isDisabled(),true);
  await page.getByTestId('admin-risk-ack').check();
  await nativeDialog(stage,kind==='export'?'save':'open',()=>page.getByTestId('admin-confirm').click(),expected);
  await page.getByRole('dialog').waitFor({state:'hidden'});
}
try {
  await save();
  app=await electron.launch({executablePath:path.join(project,'.qa/tar/agentvac-0.1.0/agentvac'),args:['--user-data-dir='+profile],chromiumSandbox:true,timeout:45000});
  page=await app.firstWindow(); page.setDefaultTimeout(20000);
  result.runtime=await app.evaluate(({app,BrowserWindow})=>({packaged:app.isPackaged,userData:app.getPath('userData'),appPath:app.getAppPath(),argv:process.argv,sandbox:BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences().sandbox,disabledSandboxSwitch:app.commandLine.hasSwitch('no-sandbox')}));
  assert.equal(result.runtime.packaged,true);assert.equal(result.runtime.userData,profile);assert.equal(result.runtime.sandbox,true);assert.equal(result.runtime.disabledSandboxSwitch,false);
  await page.getByRole('button',{name:'体验演示扫描',exact:true}).waitFor();
  await page.getByTestId('signing-warning').waitFor({state:'hidden'});
  const choose=()=>page.getByRole('button',{name:/^(选择 Codex 目录|切换目录)$/}).click();
  await nativeDialog('01-folder-cancel','open',choose,null);
  assert.equal((await page.evaluate(()=>window.agentvac.getContext())).root,null);
  await nativeDialog('02-folder-select','open',choose,selectedRoot);
  assert.equal((await page.evaluate(()=>window.agentvac.getContext())).root,selectedRoot);
  await page.getByRole('button',{name:'目录与恢复',exact:true}).click();
  const keyIdsBefore=(await page.evaluate(()=>window.agentvac.getAppData())).recovery.trustedKeyIds;
  await keyDialog('03-export-cancel','export',null);
  assert.equal(await exists(backupPath),false);
  await keyDialog('04-export-save','export',backupPath);
  assert.equal(await exists(backupPath),true);
  result.backup={bytes:(await fs.stat(backupPath)).size,sha256:await hash(backupPath),contentNeverPrinted:true};
  await keyDialog('05-import-cancel','import',null);
  assert.deepEqual((await page.evaluate(()=>window.agentvac.getAppData())).recovery.trustedKeyIds,keyIdsBefore);
  await keyDialog('06-import-own-backup','import',backupPath);
  assert.deepEqual((await page.evaluate(()=>window.agentvac.getAppData())).recovery.trustedKeyIds,keyIdsBefore);
  assert.match(await page.locator('body').innerText(),/新增 0 个恢复密钥，1 个已存在/);
  result.checks.push({stage:'key-risk-ack-reset-and-own-duplicate-import',status:'passed',keyCount:keyIdsBefore.length});
  await page.getByRole('button',{name:'文件',exact:true}).click();
  await page.getByRole('button',{name:'体验演示',exact:true}).click();
  await until(()=>page.getByRole('button',{name:'切换目录',exact:true}).isEnabled(),'demo load and scan complete');
  result.demoRoot=(await page.evaluate(()=>window.agentvac.getContext())).root;
  assert.equal(result.demoRoot,path.join(profile,'demo-workspace'));
  await page.getByRole('checkbox',{name:'选择当前列表中的安全项目',exact:true}).check();
  await page.getByRole('button',{name:'预览隔离操作',exact:true}).click();
  await page.getByRole('dialog').getByRole('checkbox').check();
  await page.getByRole('dialog').getByRole('button',{name:'确认演示隔离',exact:true}).click();
  await page.getByRole('button',{name:'查看隔离记录',exact:true}).click();
  const batch=(await page.evaluate(()=>window.agentvac.history())).find(row=>row.items.some(item=>item.status==='quarantined'));
  assert.ok(batch); result.batchId=batch.id;
  result.batchDirectory=path.join(result.demoRoot,'.agentvac-quarantine',batch.id);
  result.files=[];
  for(const item of batch.items.filter(item=>item.status==='quarantined'))result.files.push({path:item.path,size:item.size,sha256:await hash(path.join(result.batchDirectory,item.id+'.data'))});
  await page.screenshot({path:path.join(out,'07-before-trash.png')});
  await page.getByRole('button',{name:'移入系统回收站',exact:true}).first().click();
  const dialog=page.getByRole('dialog');
  assert.equal(await dialog.getByRole('button',{name:'确认移入系统回收站',exact:true}).isDisabled(),true);
  await dialog.getByRole('checkbox').check();await dialog.getByPlaceholder('回收站',{exact:true}).fill('回收站');
  await dialog.getByRole('button',{name:'确认移入系统回收站',exact:true}).click();
  await page.getByRole('heading',{name:'隔离批次已移入系统回收站',exact:true}).waitFor();
  assert.equal(await exists(result.batchDirectory),false);
  assert.ok((await page.evaluate(()=>window.agentvac.history())).find(row=>row.id===batch.id).items.every(item=>item.status==='trashed'));
  await page.getByRole('button',{name:'完成',exact:true}).click();
  await page.screenshot({path:path.join(out,'08-trashed.png')});
  await mark('awaiting_standard_system_trash_restore');
  await until(()=>exists(result.batchDirectory),'standard OS Trash restoration',20*60*1000);
  await page.getByRole('button',{name:'文件',exact:true}).click();
  await page.getByRole('button',{name:'隔离记录',exact:true}).click();
  await page.getByRole('button',{name:'恢复此批次',exact:true}).first().click();
  await page.getByRole('dialog').getByRole('button',{name:'确认恢复',exact:true}).click();
  await page.getByRole('button',{name:'完成',exact:true}).click();
  assert.ok((await page.evaluate(()=>window.agentvac.history())).find(row=>row.id===batch.id).items.every(item=>item.status==='restored'));
  for(const file of result.files)assert.equal(await hash(path.join(result.demoRoot,file.path)),file.sha256);
  result.checks.push({stage:'native-trash-standard-tool-restore-app-restore',status:'passed',restoredFiles:result.files.length,hashesMatch:true});
  await page.screenshot({path:path.join(out,'09-native-trash-roundtrip-restored.png')});
  result.status='passed';result.finishedAt=new Date().toISOString();await save();
}catch(error){result.status='failed';result.error=String(error.stack||error);await save();console.error(result.error);process.exitCode=1;await page?.screenshot({path:path.join(out,'manual-failure.png')}).catch(()=>{});}
finally{await app?.close();}
