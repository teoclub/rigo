const r = await import.meta.resolve('@teoclub/cordis')
console.log('repro resolve:', r)
try {
  const m = await import('@teoclub/cordis')
  console.log('repro FiberState:', 'FiberState' in m)
} catch (e) { console.log('repro err:', String(e.message).slice(0, 100)) }
