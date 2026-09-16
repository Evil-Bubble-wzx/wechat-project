Component({ properties: { book: Object }, methods: { open() { this.triggerEvent('open', { id: this.data.book.id }) } } })
