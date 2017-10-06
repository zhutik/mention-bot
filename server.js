/**
 * Copyright (c) 2016-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @flow
 */

var bl = require('bl');
var express = require('express');
var fs = require('fs');
var mentionBot = require('./mention-bot.js');
var messageGenerator = require('./message.js');
var util = require('util');
var schedule = require('./schedule.js');

var jsonlint = require('jsonlint');
var adapterFactory = require('./adapter/factory');

var CONFIG_PATH = '.mention-bot';

var github = adapterFactory.getAdapter('github');

var app = express();

function buildMentionSentence(reviewers) {
  var atReviewers = reviewers.map(function (owner) { return '@' + owner; });

  if (reviewers.length === 1) {
    return atReviewers[0];
  }

  return (
    atReviewers.slice(0, atReviewers.length - 1).join(', ') +
    ' and ' + atReviewers[atReviewers.length - 1]
  );
}

function getDefaultMessageGenerator(findPotentialReviewers) {
  return function (reviewers, pullRequester) {
    return util.format(
      '%s, thanks for your PR! ' +
      '%se identified %s to be%s potential reviewer%s.',
      pullRequester,
      findPotentialReviewers ? 'By analyzing the history of the files in this pull request, w' : 'W',
      buildMentionSentence(reviewers),
      reviewers.length > 1 ? '' : ' a',
      reviewers.length > 1 ? 's' : ''
    );
  }
}

function configMessageGenerator(message, reviewers, pullRequester) {
  var withReviewers = message.replace(/@reviewers/g, buildMentionSentence(reviewers));
  return withReviewers.replace(/@pullRequester/g, pullRequester);
}

function getRepoConfig(request) {
  return new Promise(function (resolve, reject) {
    let callback = function (err, result) {
        if (err) {
            reject(err);
            return;
        }
        try {
            const data = JSON.parse(result.data);
            resolve(data);
        } catch (e) {
            try {
                e.repoConfig = result.data;
            } catch (e) {}
            reject(e);
        }
    };

    github.getRepositoryContent(request, callback);
  });
}

async function work(body) {
  var data = {};
  try {
    data = JSON.parse(body.toString());
    console.log(data.pull_request.html_url);
  } catch (e) {
    console.error(e);
  }

  // default config
  var repoConfig = {
    maxReviewers: 3,
    numFilesToCheck: 5,
    userBlacklist: [],
    userBlacklistForPR: [],
    userWhitelist: [],
    fileBlacklist: [],
    requiredOrgs: [],
    findPotentialReviewers: true,
    actions: ['opened'],
    branches:[],
    skipAlreadyAssignedPR: false,
    skipAlreadyMentionedPR: false,
    delayed: false,
    delayedUntil: '3d',
    assignToReviewer: false,
    createReviewRequest: false,
    createComment: true,
    skipTitle: '',
    withLabel: '',
    skipCollaboratorPR: false,
  };

  if (process.env.MENTION_BOT_CONFIG) {
    try {
      repoConfig = {
        ...repoConfig,
        ...JSON.parse(process.env.MENTION_BOT_CONFIG)
      };
    } catch(e) {
      console.error(
        'Error attempting to read the config from the environment variable ' +
        ' MENTION_BOT_CONFIG'
      );
      console.error(e);
    }
  }

  try {
    // request config from repo
    var configRes = await getRepoConfig({
      owner: data.repository.owner.login,
      repo: data.repository.name,
      ref: data.pull_request.base.ref,
      path: CONFIG_PATH,
      headers: {
        Accept: 'application/vnd.github.v3.raw+json'
      }
    }).catch(function(e) {
      if (e instanceof SyntaxError && repoConfig.actions.indexOf(data.action) !== -1) {
        // Syntax error while reading custom configuration file
        var errorLog = '';
        try {
          jsonlint.parse(e.repoConfig)
        } catch(err) {
          errorLog = err;
        }
        var message =
          'Unable to parse mention-bot custom configuration file due to a syntax error.\n' +
          'Please check the potential root causes below:\n\n' +
          '1. Having comments\n' +
          '2. Invalid JSON type\n' +
          '3. Having extra "," in the last JSON attribute\n\n' +
          'Error message:\n' +
          '```\n' + errorLog + '\n```';
        createComment(data, message);
      }
    });
    repoConfig = {...repoConfig, ...configRes};
  } catch (e) {
    if (e.code === 404 &&
        e.message.match(/message.*Not Found.*documentation_url.*developer.github.com/)) {
      console.log('Couldn\'t find ' + CONFIG_PATH + ' in repo. Continuing with default configuration.');
    } else {
      console.error(e);
    }
  }

  function isValid(repoConfig, data) {
    if (repoConfig.branches && repoConfig.branches.length > 0 && repoConfig.branches.indexOf(data.pull_request.base.ref) === -1) {
      console.log(
        'Skipping because base ref is "' + data.pull_request.base.ref + '".',
        'We only care about: "' + repoConfig.branches.join("', '") + '"'
      );
      return false;
    }

    if (repoConfig.actions.indexOf(data.action) === -1) {
      console.log(
        'Skipping because action is "' + data.action + '".',
        'We only care about: "' + repoConfig.actions.join("', '") + '"'
      );
      return false;
    }

    if (repoConfig.withLabel && data.label && data.label.name != repoConfig.withLabel) {
      console.log('Skipping because pull request does not have label: "' + repoConfig.withLabel + '".');
      return false;
    }

    if (repoConfig.skipTitle &&
      data.pull_request.title.indexOf(repoConfig.skipTitle) > -1) {
      console.log('Skipping because pull request title contains: "' + repoConfig.skipTitle + '".');
      return false;
    }

    if (repoConfig.skipCollaboratorPR) {
      const callback = function(err, res){
        if (res && res.meta.status === '204 No Content') {
          console.log('Skipping because pull request is made by collaborator.');
          return false;
        }
      };

      github.checkCollaborator(
        {
          owner: data.repository.owner.login, // 'fbsamples'
          repo: data.repository.name, // 'bot-testing'
          username: data.pull_request.user.login
        },
        callback
      );
    }

    if (repoConfig.skipAlreadyAssignedPR &&
        data.pull_request.assignee &&
        data.pull_request.assignee.login) {
      console.log('Skipping because pull request is already assigned.');
      return false;
    }

    if (process.env.REQUIRED_ORG) {
      if (repoConfig.requiredOrgs.indexOf(process.env.REQUIRED_ORG) === -1) {
        repoConfig.requiredOrgs.push(process.env.REQUIRED_ORG);
      }
    }

    if (repoConfig.userBlacklistForPR.indexOf(data.pull_request.user.login) >= 0) {
      console.log('Skipping because blacklisted user created Pull Request.');
      return false;
    }

    if (repoConfig.skipTitle &&
      data.pull_request.title.indexOf(repoConfig.skipTitle) > -1) {
      console.log('Skipping because pull request title contains: "' + repoConfig.skipTitle + '".');
      return false;
    }

    return true;
  }

  if (!isValid(repoConfig, data)) {
    return;
  }

  var org = null;

  if (data.organization) {
    org = data.organization.login;
  }

  var reviewers = await mentionBot.guessOwnersForPullRequest(
    data.repository.html_url, // 'https://github.com/fbsamples/bot-testing'
    data.pull_request.number, // 23
    data.pull_request.user.login, // 'mention-bot'
    data.pull_request.base.ref, // 'master'
    data.repository.private, //true or false
    org, //the org name of the repo
    repoConfig,
    github.getInstance()
  );

  console.log('Reviewers:', reviewers);

  if (reviewers.length === 0) {
    console.log('Skipping because there are no reviewers found.');
    return;
  }

  var message = null;
  if (repoConfig.message) {
    message = configMessageGenerator(
      repoConfig.message,
      reviewers,
      '@' + data.pull_request.user.login
    );
  } else {
    message = messageGenerator(
      reviewers,
      '@' + data.pull_request.user.login, // pull-requester
      buildMentionSentence,
      getDefaultMessageGenerator(repoConfig.findPotentialReviewers)
    );
  }

  function createComment(data, message, reject) {
    if (!repoConfig.createComment) {
      return;
    }

    const callback = function(err) {
      if (err) {
        if (typeof reject === 'function') {
          return reject(err);
        }
      }
    };

    github.createComment(
      {
        owner: data.repository.owner.login, // 'fbsamples'
        repo: data.repository.name, // 'bot-testing'
        number: data.pull_request.number, // 23
        body: message
      },
      callback
    )
  }

  function assignReviewer(data, reviewers, reject) {
    if (!repoConfig.assignToReviewer) {
      return;
    }

    const callback = function(err) {
      if (err) {
        if (typeof reject === 'function') {
          return reject(err);
        }
      }
    };

    github.assignReviewer(
      {
        owner: data.repository.owner.login, // 'fbsamples'
        repo: data.repository.name, // 'bot-testing'
        number: data.pull_request.number, // 23
        assignees: reviewers
      },
      callback
    );
  }

  function requestReview(data, reviewers, reject) {
    if (!repoConfig.createReviewRequest) {
      return;
    }

    const callback = function(err) {
      if (err) {
        if (typeof reject === 'function') {
          return reject(err);
        }
      }
    };

    github.createReviewRequest(
      {
        owner: data.repository.owner.login, // 'fbsamples'
        repo: data.repository.name, // 'bot-testing'
        number: data.pull_request.number, // 23
        reviewers: reviewers
      },
      callback
    );
  }

  function getComments(data, page) {
    return new Promise(function(resolve, reject) {

      const callback = function(err, result) {
        if (err) {
          reject(err);
        }
        resolve(result);
      };

      github.getComments(
        {
          owner: data.repository.owner.login, // 'fbsamples'
          repo: data.repository.name, // 'bot-testing'
          number: data.pull_request.number, // 23
          page: page, // 1
          per_page: 100 // maximum supported
        },
        callback
      );
    });
  }

  if (repoConfig.skipAlreadyMentionedPR) {
    var page;
    var comments = [[]];

    for (page = 1; comments.length != 0; ++page) {
      comments = await getComments(data, page);
      if (comments.find(function(comment) {
        return comment.body == message;
      })) {
        console.log('Skipping because there is already existing an exact mention.');
        return;
      }
    }
  }

  if (repoConfig.delayed) {
    schedule.performAt(schedule.parse(repoConfig.delayedUntil), function(resolve, reject) {

      const callback = function(err, currentData) {
        if (err) {
          reject(err);
          return;
        }

        if (!isValid(repoConfig, currentData)) {
          reject('PR validation failed');
          return;
        }

        createComment(currentData, message, reject);
        assignReviewer(currentData, reviewers, reject);
        requestReview(currentData, reviewers, reject);
      };

      github.getPullRequest(
        {
          owner: data.repository.owner.login,
          repo: data.repository.name,
          number: data.pull_request.number
        },
        callback
      );
    });
  } else {
    createComment(data, message);
    assignReviewer(data, reviewers);
    requestReview(data, reviewers);
  }

  return;
};

app.post('/', function(req, res) {
  req.pipe(bl(function(err, body) {
    work(body)
      .then(function() { res.end(); })
      .catch(function(e) {
        console.error(e);
        console.error(e.stack);
        res.status(500).send('Internal Server Error');
      });
  }));
});

app.get('/', function(req, res) {
  res.send(
    'GitHub Mention Bot Active. ' +
    'Go to https://github.com/facebook/mention-bot for more information.'
  );
});

app.set('port', process.env.PORT || 5000);

app.listen(app.get('port'), function() {
  console.log('Listening on port', app.get('port'));
});
