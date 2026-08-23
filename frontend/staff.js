const STATUS_FLOW = ['NEW', 'PREPARING', 'READY', 'COMPLETED'];

const ordersBody = document.getElementById('ordersBody');
const emptyMessage = document.getElementById('emptyMessage');
const refreshBtn = document.getElementById('refreshBtn');

function formatItems(items) {
  return items
    .map((line) => {
      const options = Object.values(line.options || {}).filter(Boolean).join(', ');
      return `${line.quantity}× ${line.id}${options ? ` (${options})` : ''}`;
    })
    .join(', ');
}

function formatCustomer(order) {
  const parts = [order.customer && order.customer.name].filter(Boolean);
  if (order.orderType === 'delivery' && order.delivery && order.delivery.address) {
    parts.push(order.delivery.address);
  }
  return parts.length ? parts.join(' — ') : '—';
}

function createCell(text) {
  const td = document.createElement('td');
  td.textContent = text;
  return td;
}

async function advanceStatus(id, nextStatus) {
  const res = await fetch(`/api/staff/orders/${id}/status`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: nextStatus }),
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    alert(data.error || 'Failed to update order status.');
    return;
  }

  loadOrders();
}

function renderOrders(orders) {
  ordersBody.innerHTML = '';
  emptyMessage.hidden = orders.length > 0;

  orders.forEach((order) => {
    const row = document.createElement('tr');

    row.appendChild(createCell(order.id.slice(0, 8)));
    row.appendChild(createCell(formatItems(order.items)));
    row.appendChild(createCell(order.orderType));
    row.appendChild(createCell(formatCustomer(order)));
    row.appendChild(createCell(`$${order.total.toFixed(2)}`));

    const statusCell = document.createElement('td');
    const badge = document.createElement('span');
    badge.className = `status-badge status-${order.status.toLowerCase()}`;
    badge.textContent = order.status;
    statusCell.appendChild(badge);
    row.appendChild(statusCell);

    const actionCell = document.createElement('td');
    const nextStatus = STATUS_FLOW[STATUS_FLOW.indexOf(order.status) + 1];
    if (nextStatus) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'advance-btn';
      button.textContent = `Mark ${nextStatus}`;
      button.addEventListener('click', () => advanceStatus(order.id, nextStatus));
      actionCell.appendChild(button);
    }
    row.appendChild(actionCell);

    ordersBody.appendChild(row);
  });
}

async function loadOrders() {
  const res = await fetch('/api/staff/orders');
  const orders = await res.json();
  orders.sort((a, b) => new Date(b.confirmedAt) - new Date(a.confirmedAt));
  renderOrders(orders);
}

refreshBtn.addEventListener('click', loadOrders);
loadOrders();
