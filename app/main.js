// 待办应用 JavaScript
// 从 localStorage 加载待办事项
class TodoApp {
  constructor() {
    this.todos = JSON.parse(localStorage.getItem('todos')) || [];
    this.init();
  }

  init() {
    this.bindEvents();
    this.render();
  }

  bindEvents() {
    // 添加待办事项
    const addBtn = document.getElementById('add-btn');
    const todoInput = document.getElementById('todo-input');
    
    if (addBtn && todoInput) {
      addBtn.addEventListener('click', () => this.addTodo());
      todoInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') this.addTodo();
      });
    }

    // 绑定删除和编辑事件（委托到列表）
    const todoList = document.getElementById('todo-list');
    if (todoList) {
      todoList.addEventListener('click', (e) => {
        const todoItem = e.target.closest('.todo-item');
        if (!todoItem) return;
        
        const todoId = parseInt(todoItem.dataset.id);
        
        // 删除按钮
        if (e.target.classList.contains('delete-btn')) {
          this.deleteTodo(todoId);
        }
        
        // 编辑按钮
        if (e.target.classList.contains('edit-btn')) {
          this.editTodo(todoId);
        }
        
        // 复选框
        if (e.target.classList.contains('todo-checkbox')) {
          this.toggleComplete(todoId);
        }
      });
    }
  }

  addTodo() {
    const todoInput = document.getElementById('todo-input');
    const text = todoInput.value.trim();
    
    if (text) {
      const newTodo = {
        id: Date.now(),
        text: text,
        completed: false,
        createdAt: new Date().toISOString()
      };
      
      this.todos.push(newTodo);
      this.saveToStorage();
      this.render();
      
      todoInput.value = '';
      todoInput.focus();
    }
  }

  deleteTodo(id) {
    this.todos = this.todos.filter(todo => todo.id !== id);
    this.saveToStorage();
    this.render();
  }

  editTodo(id) {
    const todo = this.todos.find(todo => todo.id === id);
    if (!todo) return;
    
    const newText = prompt('编辑待办事项:', todo.text);
    if (newText !== null && newText.trim() !== '') {
      todo.text = newText.trim();
      this.saveToStorage();
      this.render();
    }
  }

  toggleComplete(id) {
    const todo = this.todos.find(todo => todo.id === id);
    if (todo) {
      todo.completed = !todo.completed;
      this.saveToStorage();
      this.render();
    }
  }

  saveToStorage() {
    localStorage.setItem('todos', JSON.stringify(this.todos));
  }

  render() {
    const todoList = document.getElementById('todo-list');
    const statsEl = document.getElementById('stats');
    
    if (!todoList) return;
    
    // 渲染待办列表
    if (this.todos.length === 0) {
      todoList.innerHTML = `
        <div class="empty-state">
          <i>📝</i>
          <h3>还没有待办事项</h3>
          <p>添加第一个待办事项开始吧！</p>
        </div>
      `;
    } else {
      todoList.innerHTML = this.todos.map(todo => `
        <div class="todo-item" data-id="${todo.id}">
          <input type="checkbox" class="todo-checkbox" ${todo.completed ? 'checked' : ''}>
          <span class="todo-text ${todo.completed ? 'completed' : ''}">${this.escapeHtml(todo.text)}</span>
          <div class="todo-actions">
            <button class="edit-btn">编辑</button>
            <button class="delete-btn">删除</button>
          </div>
        </div>
      `).join('');
    }
    
    // 更新统计信息
    const total = this.todos.length;
    const completed = this.todos.filter(todo => todo.completed).length;
    
    if (statsEl) {
      statsEl.innerHTML = `总计: ${total} 个 | 已完成: ${completed} 个 | 待办: ${total - completed} 个`;
    }
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}

// 初始化应用
document.addEventListener('DOMContentLoaded', () => {
  new TodoApp();
});