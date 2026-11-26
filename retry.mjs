// 무료 ARM VM(DK 컴퍼니용)을 자리가 날 때까지 만들어 보는 스크립트. 예약 작업이 5분마다 실행해요.
// - 이미 VM이 있으면(만드는 중 포함) 절대 또 만들지 않아요: 무료 한도(ARM 합계 2코어·12GB)를 넘지 않게.
// - 실행할 때마다 2코어·12GB와 1코어·6GB를 번갈아 시도해요.
// - 성공하면 공용 IP를 dk-vm.json 에 적고, 알림을 띄우고, 예약 작업을 꺼요.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cfg, oci } from './oci.mjs';

const dir = path.join(os.homedir(), '.oci');
const log = (m) => fs.appendFileSync(path.join(dir, 'retry.log'), `${new Date().toLocaleString('ko-KR')} ${m}\n`);
const TASK = 'dk-oracle-retry';
const c = cfg.tenancy;
const t = encodeURIComponent(c);

function done(msg) {
  log(msg);
  try { execFileSync('schtasks', ['/Change', '/TN', TASK, '/DISABLE'], { stdio: 'ignore' }); } catch { /* 예약 작업 없이 직접 실행한 경우 */ }
  try { execFileSync('msg', [os.userInfo().username, `[DK 컴퍼니] ${msg}`], { stdio: 'ignore' }); } catch { /* 알림 실패는 무시 */ }
}

try {
  const live = (await oci('iaas', 'GET', `/20160918/instances?compartmentId=${t}`)).filter((i) => !['TERMINATED', 'TERMINATING'].includes(i.lifecycleState));
  if (live.length) {
    const vm = live[0];
    let ip = '';
    try {
      const att = await oci('iaas', 'GET', `/20160918/vnicAttachments?compartmentId=${t}&instanceId=${vm.id}`);
      if (att[0]) ip = (await oci('iaas', 'GET', `/20160918/vnics/${att[0].vnicId}`)).publicIp ?? '';
    } catch { /* 아직 네트워크 카드가 안 붙었을 수 있어요 */ }
    fs.writeFileSync(path.join(dir, 'dk-vm.json'), JSON.stringify({ id: vm.id, state: vm.lifecycleState, shape: vm.shapeConfig, publicIp: ip }, null, 2));
    if (vm.lifecycleState === 'RUNNING' && ip) done(`오라클 VM이 만들어졌어요! (${vm.shapeConfig?.ocpus}코어 ${vm.shapeConfig?.memoryInGBs}GB, IP ${ip})`);
    else log(`VM이 이미 있어요: ${vm.lifecycleState} (만들지 않음)`);
    process.exit(0);
  }

  const { subnetId } = JSON.parse(fs.readFileSync(path.join(dir, 'dk-network.json'), 'utf8'));
  const ad = (await oci('identity', 'GET', `/20160918/availabilityDomains?compartmentId=${t}`))[0].name;
  const img = (await oci('iaas', 'GET', `/20160918/images?compartmentId=${t}&operatingSystem=Canonical%20Ubuntu&operatingSystemVersion=24.04&shape=VM.Standard.A1.Flex&sortBy=TIMECREATED&sortOrder=DESC`))[0];
  const sshKey = fs.readFileSync(path.join(os.homedir(), '.ssh', 'oracle-dk.key.pub'), 'utf8').trim();

  // 한 번에 하나씩, 실행할 때마다 크기를 번갈아요(연달아 요청하면 429로 막혀서)
  const turnFile = path.join(dir, 'retry-turn.txt');
  const turn = fs.existsSync(turnFile) ? Number(fs.readFileSync(turnFile, 'utf8')) || 0 : 0;
  fs.writeFileSync(turnFile, String(turn + 1));
  for (const [ocpus, memoryInGBs] of [turn % 2 ? [1, 6] : [2, 12]]) {
    try {
      const vm = await oci('iaas', 'POST', '/20160918/instances', {
        availabilityDomain: ad, compartmentId: c, displayName: 'dk-company',
        shape: 'VM.Standard.A1.Flex', shapeConfig: { ocpus, memoryInGBs },
        sourceDetails: { sourceType: 'image', imageId: img.id, bootVolumeSizeInGBs: 100 },
        createVnicDetails: { subnetId, assignPublicIp: true },
        metadata: { ssh_authorized_keys: sshKey },
      });
      log(`만들기 시작! ${ocpus}코어 ${memoryInGBs}GB (${vm.lifecycleState}) - 다음 실행 때 IP를 확인해요`);
      process.exit(0);
    } catch (e) {
      const full = /capacity/i.test(e.message);
      const busy = e.status === 429;
      log(`${ocpus}코어 ${memoryInGBs}GB 실패: ${full ? '자리 없음' : busy ? '요청이 잦아 잠시 쉬어요(다음 차례에)' : e.message}`);
      if (busy) process.exit(0);
      if (!full) process.exit(1); // 자리 문제가 아니면(설정 오류 등) 작은 크기로 넘어가지 않아요
      await new Promise((r) => setTimeout(r, 15000)); // 다음 크기 전에 잠깐 쉬어요(요청 제한 피하기)
    }
  }
} catch (e) {
  log(`오류: ${e.message}`);
  process.exit(1);
}
