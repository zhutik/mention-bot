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

const GitHubApi = require('github');
const config = require('../config');

function GithubInstance() {
  if (!process.env.GITHUB_TOKEN) {
    let error = 'The bot was started without a GitHub account to post with.' + '\n'
      + 'To get started:' + '\n'
      + '1) Create a new account for the bot' + '\n'
      + '2) Settings > Personal access tokens > Generate new token' + '\n'
      + '3) Only check `public_repo` and click Generate token' + '\n'
      + '4) Run the following command:' + '\n'
      + 'GITHUB_TOKEN=insert_token_here npm start' + '\n'
      + '5) Run the following command in another tab:' + '\n'
      + 'curl -X POST -d @__tests__/data/23.webhook http://localhost:5000/' + '\n'
      + '6) Check if it has commented here:'
      + 'https://github.com/fbsamples/bot-testing/pull/23' + '\n';

    throw new Error(error);
  }

  if (!process.env.GITHUB_USER) {
    console.warn(
      'There was no GitHub user detected.',
      'This is fine, but mention-bot won\'t work with private repos.'
    );
    console.warn(
      'To make mention-bot work with private repos, please expose',
      'GITHUB_USER and GITHUB_PASSWORD as environment variables.',
      'The username and password must have access to the private repo',
      'you want to use.'
    );
  }

  const github = new GitHubApi({
    host: config.github.apiHost,
    pathPrefix: config.github.pathPrefix,
    protocol: config.github.protocol,
    port: config.github.port,
  });

  github.authenticate({
    type: 'oauth',
    token: process.env.GITHUB_TOKEN,
  });

  return {
    getRepositoryContent: function (request, callback) {
      return github.repo.getContent(request, callback);
    },

    checkCollaborator: function (params, callback) {
      return github.repo.checkCollaborator(params, callback);
    },

    createComment: function (params, callback) {
      return github.issues.createComment(params, callback);
    },

    assignReviewer: function (params, callback) {
      return github.issues.edit(params, callback);
    },

    createReviewRequest: function (params, callback) {
      return github.pullRequests.createReviewRequest(params, callback);
    },

    getComments: function (params, callback) {
      return github.issues.getComments(params, callback);
    },

    getPullRequest: function (params, callback) {
      return github.pullRequests.get(params, callback);
    },

    getInstance: function () {
      return github;
    },
  };
}

module.exports = new GithubInstance();
