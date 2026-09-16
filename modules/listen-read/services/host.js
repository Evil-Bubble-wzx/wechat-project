// Replace this adapter when integrating into another mini program.
const KEY = 'yaya-listen-read-v1'
let adapter = {
  read() { try { return wx.getStorageSync(KEY) || {} } catch (e) { return {} } },
  write(value) { wx.setStorageSync(KEY, value) }
}
function configure(overrides) { adapter = Object.assign({}, adapter, overrides) }
module.exports = { configure, read: () => adapter.read(), write: value => adapter.write(value) }
