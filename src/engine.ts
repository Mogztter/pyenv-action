import * as path from 'path';
import * as fs from 'fs';
import * as core from '@actions/core';
import * as github from '@actions/github';
import * as tc from '@actions/tool-cache';
import * as exec from '@actions/exec';

import * as utils from './utils';

interface BuildContextParams {
  pyenv_version: string;
}

export class ParsedInputs {
  // the types below represent the inputs from action.yml, the mapping
  // is done in the constructor retrieves inputs using @actions/core,
  // parses them into correct types and set these readonly properties.
  readonly default_version: string;
  private explicit_versions: Array<string>;
  readonly command: string;

  constructor() {
    this.default_version = core.getInput('default');
    this.command = core.getInput('command');
    this.explicit_versions = utils.splitcommas(core.getInput('versions'));
  }
  get versions() {
    const values = utils.unique(this.explicit_versions);
    if (this.default_version.length > 4) {
      values.push(this.default_version);
    }
    values.sort();
    return values;
  }
  get sanitized_command(): string {
    const parts: Array<string> = this.command.split(/\r?\n/);
    const body: string = parts.join(';\n');
    return `${body};`;
  }
  get_command_as_shell_script(shell: string, python_version: string): string {
    return [
      `#!${shell}`,
      '# auto-generated by gabrielfalcao/pyenv-action',
      '',
      '# set python version within this script',
      `export PYENV_VERSION="${python_version}";`,
      '',
      '# run user-provided command:',
      this.sanitized_command
    ].join('\n');
  }
}

export class BuildContext {
  readonly pyenv_version: string;
  readonly inputs: ParsedInputs;

  constructor(params: BuildContextParams) {
    const {pyenv_version} = params;
    this.pyenv_version = pyenv_version;
    this.inputs = new ParsedInputs();
  }
}

interface EnvironmentManagerParams {
  pyenv_root: string;
  context: BuildContext;
}

export class PyEnvInstaller {
  readonly pyenv_version: string;

  private archive_path: string;
  private deflated_location: string;

  get archive_url(): string {
    return `https://github.com/pyenv/pyenv/archive/v${this.pyenv_version}.zip`; // note the deliberate "v" prefix of pyenv version
  }

  constructor(pyenv_version: string) {
    this.pyenv_version = pyenv_version;
    this.archive_path = `/tmp/pyenv-${this.pyenv_version}-inflated`;
    this.deflated_location = tc.find('pyenv_root', this.pyenv_version);
  }

  get pyenv_root(): string {
    return this.deflated_location;
  }

  async downloadArchive(): Promise<string> {
    return new Promise<string>((accept, reject) => {
      const cache_key = `pyenv-archive.zip`;
      const cache_version = this.pyenv_version;
      const cached_archive = tc.find(cache_key, cache_version);

      if (utils.file_exists(cached_archive)) {
        return accept(path.join(cached_archive, cache_key));
      }
      console.log(`downloading ${this.archive_url}`);
      tc.downloadTool(this.archive_url)
        .then(archive_path => {
          tc.cacheFile(archive_path, cache_key, cache_key, cache_version)
            .then(cached_path => {
              if (!utils.folder_exists(cached_path)) {
                return reject(new Error(`${cached_path} does not exist`));
              }
              accept(path.join(cached_path, cache_key));
            })
            .catch(error => {
              console.log(
                `failed to cache ${archive_path}, proceeding anyway...`
              );
              accept(archive_path);
            });
        })
        .catch(err => {
          reject(
            new Error(
              `Cannot download archive for pyenv "${this.pyenv_version}": ${err.message}`
            )
          );
        });
    });
  }

  async installFromArchive(archive_path: string): Promise<string> {
    return new Promise<string>((accept, reject) => {
      if (utils.file_exists(this.archive_path)) {
        return accept(
          path.join(this.archive_path, `pyenv-${this.pyenv_version}`)
        );
      }
      tc.extractZip(archive_path, tc.find('pyenv_archive', this.pyenv_version))
        .then(inflation_path => {
          console.log(`Extracted ${archive_path} to ${inflation_path}.`);
          const deflated_location = path.join(
            inflation_path,
            `pyenv-${this.pyenv_version}`
          ); // TODO: find the path with glob matching the version
          if (!utils.folder_exists(deflated_location)) {
            return reject(
              new Error(
                `failed to deflate ${archive_path}: ${deflated_location} does not exist`
              )
            );
          }

          tc.cacheDir(deflated_location, 'pyenv_root', this.pyenv_version)
            .then(pyenv_root => {
              core.setOutput('pyenv_root', pyenv_root);
              accept(pyenv_root);
            })
            .catch(error => {
              reject(error);
            });
        })
        .catch(err => {
          reject(err);
        });
    });
  }
}

export class EnvironmentManager {
  private context: BuildContext;
  private inputs: ParsedInputs;
  private pyenv_version: string;
  private command_filename: string;
  private command_script_path: string;
  readonly pyenv_root: string;
  readonly pyenv_bin_path: string;
  readonly pyenv_shims_path: string;

  constructor(params: EnvironmentManagerParams) {
    const {context, pyenv_root} = params;

    this.context = context;
    this.inputs = context.inputs;
    this.pyenv_version = context.pyenv_version;
    this.pyenv_root = pyenv_root;
    this.pyenv_bin_path = `${this.pyenv_root}/bin`;
    this.pyenv_shims_path = `${this.pyenv_root}/shims`;
    this.command_filename = 'pyenv_post_install.sh';
    this.command_script_path = `/tmp/after-each-python-install-command.sh`;
    if (!utils.folder_exists(this.pyenv_root)) {
      throw new Error(
        `${this.pyenv_root} does not exist, make sure to install pyenv before setting up the environment`
      );
    }
    if (!utils.folder_exists(this.pyenv_bin_path)) {
      throw new Error(
        `${this.pyenv_bin_path} does not exist, make sure to install pyenv before setting up the environment`
      );
    }
  }

  setup() {
    core.exportVariable('PYENV_ROOT', this.pyenv_root);
    console.log(`export PYENV_ROOT="${this.pyenv_root}"`);

    core.addPath(this.pyenv_bin_path);
    core.addPath(this.pyenv_shims_path);
    console.log(`Patched PATH with "${this.pyenv_bin_path}"`);
  }

  async ensure_script_exists_with_command(version: string): Promise<string> {
    return new Promise<string>((accept, reject) => {
      const cache_key = `pyenv-${this.pyenv_version}-command-${version}`;
      const cache_version = version;

      if (typeof version != 'string') {
        return reject(new Error(`version ${version} is not a string`));
      }
      if (version.length < 4) {
        return reject(new Error(`version "${version}" is invalid`));
      }

      const command_body: string = this.context.inputs.get_command_as_shell_script(
        '/bin/bash',
        version
      );

      const cached_path: string = tc.find(cache_key, cache_version);

      if (utils.file_exists(cached_path)) {
        return accept(path.join(cached_path, this.command_filename));
      }

      fs.writeFile(this.command_script_path, command_body, error => {
        if (error) return reject(error);
        tc.cacheFile(
          this.command_script_path,
          this.command_filename,
          cache_key,
          cache_version
        )
          .then(cached_script_path => {
            const script_path = path.join(
              cached_script_path,
              this.command_filename
            );
            accept(script_path);
          })
          .catch(error => {
            reject(error);
          });
      });
    });
  }
  async run_command_in_python_version(version: string): Promise<boolean> {
    return new Promise<boolean>((accept, reject) => {
      if (typeof version != 'string') {
        return reject(new Error(`version ${version} is not a string`));
      }
      if (version.length < 4) {
        return reject(new Error(`version "${version}" is invalid`));
      }

      this.ensure_script_exists_with_command(version)
        .then(command_path => {
          exec
            .exec(`bash ${command_path}`)
            .then(() => {
              accept(true);
            })
            .catch(error => {
              reject(error);
            });
        })
        .catch(error => {
          reject(error);
        });
    });
  }
  get_path_to_python_installation(python_version: string): string {
    return `${this.pyenv_root}/versions/${python_version}`;
  }
  async install_python_with_pyenv(version: string): Promise<string> {
    return new Promise<string>((accept, reject) => {
      if (typeof version != 'string') {
        return reject(new Error(`${version} is not a string`));
      }
      if (version.length < 4) {
        return reject(new Error(`version "${version}" is invalid`));
      }

      const cache_key = `pyenv-${this.pyenv_version}-python`;
      const cache_version = version;

      const cached_python = tc.find(cache_key, cache_version);
      if (utils.folder_exists(cached_python)) {
        return accept(cached_python);
      }

      exec
        .exec(`pyenv install ${version}`)
        .then(() => {
          console.log(`Sucessfully installed python ${version}`);
          tc.cacheDir(
            this.get_path_to_python_installation(version),
            cache_key,
            cache_version
          ).then(cached_path => {
            this.run_command_in_python_version(version)
              .then(() => {
                accept(cached_path);
              })
              .catch(error => {
                console.error(
                  `Failed to run command for pyenv's python ${version}`
                );
                reject(error);
              });
          });
        })
        .catch(error => {
          console.error(`Failed to install python ${version}`);
          reject(error);
        });
    });
  }
  async install_versions(): Promise<Array<string>> {
    return new Promise<Array<string>>((accept, reject) => {
      const installed: Array<string> = [];
      this.context.inputs.versions.forEach(version => {
        this.install_python_with_pyenv(version)
          .then(() => {
            installed.push(version);
            if (installed.length == this.inputs.versions.length) {
              accept(installed);
            }
          })
          .catch(error => {
            reject(error);
          });
      });
    });
  }
  async set_default_version(): Promise<string> {
    return new Promise<string>((accept, reject) => {
      const version = this.context.inputs.default_version;

      const cached_python = tc.find(`pyenv-python`, version);
      if (!utils.folder_exists(cached_python)) {
        return reject(
          new Error(`python ${version} was not installed via pyenv`)
        );
      }

      exec
        .exec(`pyenv local ${this.context.inputs.default_version}`)
        .then(() => {
          console.log(`Sucessfully installed python ${version}`);
          accept(cached_python);
        })
        .catch(error => {
          console.error(`Failed to set python ${version}: {error.message}`);
          reject(error);
        });
    });
  }

  debug() {
    const payload = JSON.stringify(github.context.payload, undefined, 2);
    console.log(`Event payload: ${payload}`);
  }
}