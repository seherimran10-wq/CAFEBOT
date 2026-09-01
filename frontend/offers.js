// Cafe Agent offers page

document.addEventListener('DOMContentLoaded', function () {
  var list = document.getElementById('offersList');

  var STATUS_LABEL = {
    active: 'Active now',
    upcoming: 'Upcoming',
    inactive: 'Not active',
  };

  function renderOffers(promotions) {
    if (!promotions.length) {
      list.textContent = 'No offers to show right now.';
      return;
    }

    list.innerHTML = '';
    promotions.forEach(function (promotion) {
      var card = document.createElement('article');
      card.className = 'offer-card';

      var badge = document.createElement('span');
      badge.className = 'offer-status offer-status--' + promotion.status;
      badge.textContent = STATUS_LABEL[promotion.status] || promotion.status;

      var name = document.createElement('h3');
      name.className = 'offer-name';
      name.textContent = promotion.name;

      var rule = document.createElement('p');
      rule.className = 'offer-rule';
      rule.textContent = promotion.rule;

      card.appendChild(badge);
      card.appendChild(name);
      card.appendChild(rule);

      if (promotion.schedule) {
        var schedule = document.createElement('p');
        schedule.className = 'offer-schedule';
        schedule.textContent = promotion.status === 'active'
          ? 'Available: ' + promotion.schedule
          : 'Runs: ' + promotion.schedule;
        card.appendChild(schedule);
      }

      list.appendChild(card);
    });
  }

  fetch('/api/promotions')
    .then(function (response) {
      if (!response.ok) {
        throw new Error('Request failed with status ' + response.status);
      }
      return response.json();
    })
    .then(renderOffers)
    .catch(function () {
      list.textContent = "Sorry, offers couldn't be loaded right now. Please try again in a moment.";
    });
});
