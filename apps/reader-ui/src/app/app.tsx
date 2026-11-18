import { useEffect, useState } from 'react';
import { Link, Route, Routes } from 'react-router-dom';
import type { StorageBridge } from '../../../reader/src/app/api/storage-bridge';

declare global {
  interface Window {
    reader?: StorageBridge;
  }
}

export function App() {
  const [status, setStatus] = useState('正在检查本地数据目录…');
  const [recovery, setRecovery] = useState<Awaited<ReturnType<StorageBridge['getStorageStatus']>>['recovery']>([]);
  useEffect(() => {
    if (!window.reader) {
      setStatus('浏览器预览：请在桌面应用中使用本地存储。');
      return;
    }
    let active = true;
    window.reader.getStorageStatus().then(
      (result) => {
        if (active) {
          setStatus(result.message);
          setRecovery(result.recovery.filter((entry) => entry.valid && entry.checksum));
        }
      },
      () => { if (active) setStatus('无法读取存储状态。请重启应用后重试。'); },
    );
    return () => { active = false; };
  }, []);
  return (
    <main>
      <h1>Reader · 静读</h1>
      <nav aria-label="主导航">
        <Link to="/">书架</Link> · <Link to="/about">关于</Link>
      </nav>
      <Routes>
        <Route path="/" element={<>
          <h2>书架为空</h2>
          <p>工程基础已就绪。图书导入将在下一阶段提供。</p>
          <p role="status">{status}</p>
          {recovery.length > 0 && <section aria-labelledby="recovery-heading">
            <h2 id="recovery-heading">恢复数据</h2>
            <p>数据未被覆盖。选择已验证的版本以从副本恢复；所有原始文件将保留。</p>
            <ul>{recovery.map((candidate) => <li key={`${candidate.name}-${candidate.checksum}`}>
              <button type="button" onClick={async () => {
                if (!window.reader || !candidate.checksum || !window.confirm('从选定版本恢复？现有文件会保留。')) return;
                try {
                  const latest = (await window.reader.getStorageStatus()).expectedRevision;
                  const result = await window.reader.recover('settings', {
                    name: candidate.name,
                    checksum: candidate.checksum,
                    expectedRevision: latest,
                  });
                  if (!result) throw new Error('恢复未完成');
                  const refreshed = await window.reader.getStorageStatus();
                  setStatus(refreshed.message);
                  setRecovery(refreshed.recovery.filter((entry) => entry.valid && entry.checksum));
                } catch {
                  setStatus('恢复失败或数据已变化。原文件已保留；请重新启动并重新检查恢复点。');
                }
              }}>从已验证副本恢复（版本 {candidate.revision}）</button>
            </li>)}</ul>
          </section>}
        </>} />
        <Route path="/about" element={<><h2>关于 Reader</h2><p>离线阅读与笔记。默认不联网，无遥测与自动更新。</p><p>当前为阶段 0 工程版本。</p></>} />
        <Route path="*" element={<p>页面不存在。<Link to="/">返回书架</Link></p>} />
      </Routes>
    </main>
  );
}

export default App;
