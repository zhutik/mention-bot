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

function getAdapter(name) {
  try {
    switch (name.toLowerCase()) {
      case 'github':
        return require('./github');
    }
  } catch (e) {
    console.error(e);
    process.exit(1);
  }

  throw new Error('Adapter ' + name + ' is not implemented!');
}

module.exports = {
  getAdapter: getAdapter,
};
