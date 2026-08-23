// CafeBot chat widget

document.addEventListener('DOMContentLoaded', function () {
  var toggle = document.getElementById('chatToggle');
  var closeBtn = document.getElementById('chatClose');
  var chatWindow = document.getElementById('chatWindow');
  var form = document.getElementById('chatForm');
  var input = document.getElementById('chatInput');
  var sendBtn = document.getElementById('chatSend');
  var messages = document.getElementById('chatMessages');

  var ERROR_REPLY = "Sorry, I'm having trouble connecting right now. Please try again in a moment.";
  var HISTORY_LIMIT = 20;

  var conversationHistory = [];
  var typingBubble = null;

  function openChat() {
    chatWindow.hidden = false;
    toggle.setAttribute('aria-expanded', 'true');
    input.focus();
  }

  function closeChat() {
    chatWindow.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
  }

  function addBubble(text, sender) {
    var bubble = document.createElement('div');
    bubble.className = 'chat-bubble ' + (sender === 'user' ? 'chat-bubble-user' : 'chat-bubble-bot');
    // Bot replies use markdown-style ** for emphasis, but bubbles render plain text.
    bubble.textContent = sender === 'user' ? text : text.replace(/\*\*(.+?)\*\*/g, '$1');
    messages.appendChild(bubble);
    messages.scrollTop = messages.scrollHeight;
    return bubble;
  }

  function showTyping() {
    typingBubble = addBubble('CafeBot is typing…', 'bot');
  }

  function hideTyping() {
    if (typingBubble) {
      typingBubble.remove();
      typingBubble = null;
    }
  }

  function setSending(isSending) {
    input.disabled = isSending;
    sendBtn.disabled = isSending;
  }

  toggle.addEventListener('click', function () {
    if (chatWindow.hidden) {
      openChat();
    } else {
      closeChat();
    }
  });

  closeBtn.addEventListener('click', closeChat);

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    var text = input.value.trim();
    if (!text) {
      return;
    }

    addBubble(text, 'user');
    input.value = '';
    setSending(true);
    showTyping();

    fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: text,
        conversationHistory: conversationHistory.slice(-HISTORY_LIMIT),
      }),
    })
      .then(function (response) {
        if (!response.ok) {
          throw new Error('Request failed with status ' + response.status);
        }
        return response.json();
      })
      .then(function (data) {
        hideTyping();
        addBubble(data.reply || ERROR_REPLY, 'bot');
        conversationHistory = Array.isArray(data.conversationHistory)
          ? data.conversationHistory
          : conversationHistory;
      })
      .catch(function () {
        hideTyping();
        addBubble(ERROR_REPLY, 'bot');
      })
      .finally(function () {
        setSending(false);
        input.focus();
      });
  });
});
