
const command = process.argv[2]


if (command === 'init') {
  import('./config/init').then(m => m.runInit())
} else {
  import('./main').then(m => m.startAgent().catch(console.error))
}
