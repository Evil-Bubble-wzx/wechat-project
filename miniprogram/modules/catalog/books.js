// Demo content only. Asset IDs stay stable when a real content API is connected.
const books = require('./catalog-data')
const questions = [
  { q:'What does Peter wear?', zh:'彼得穿着什么？', options:['A blue jacket','A red hat','A green scarf'], answer:0 },
  { q:'Where does Peter go?', zh:'彼得去了哪里？', options:['To the beach','Into the garden','To school'], answer:1 },
  { q:'What kind of animal is Peter?', zh:'彼得是什么动物？', options:['A fox','A mouse','A rabbit'], answer:2 },
  { q:'Which word means “花园”?', zh:'选出正确的英文单词。', options:['Jacket','Garden','Rabbit'], answer:1 },
  { q:'What can we learn from the story?', zh:'故事带给我们什么启发？', options:['Never go outside','Be curious and stay safe','Only eat sweets'], answer:1 }
]
module.exports = { books, questions }
