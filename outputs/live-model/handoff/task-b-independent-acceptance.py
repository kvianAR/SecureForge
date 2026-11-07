import copy
import json
from datetime import timedelta
from pathlib import Path

import flask
import pytest
from click.testing import CliRunner
from flask import Flask
from flask.cli import FlaskGroup


@pytest.mark.parametrize('key', ['SECRET_VALUE', 'my_password', 'Api_Token', 'apiKEY'])
def test_sensitive_keys_and_config_nonmutation(key):
    app = Flask(__name__)
    app.config[key] = 0
    app.config['VISIBLE'] = 'ordinary'
    before = copy.deepcopy(dict(app.config))
    result = CliRunner().invoke(FlaskGroup(create_app=lambda: app), ['config'])
    assert result.exit_code == 0, result.output
    values = json.loads(result.output)
    assert values[key] == '***'
    assert values['VISIBLE'] == 'ordinary'
    assert dict(app.config) == before
    assert Path(flask.__file__).resolve().is_relative_to(Path(__file__).resolve().parents[1] / 'src')


def test_nested_sensitive_settings():
    app = Flask(__name__)
    app.config['NESTED'] = {'ordinary': 'visible', 'api_token': 0, 'items': [{'password': False}]}
    before = copy.deepcopy(dict(app.config))
    result = CliRunner().invoke(FlaskGroup(create_app=lambda: app), ['config'])
    assert result.exit_code == 0, result.output
    values = json.loads(result.output)
    assert values['NESTED']['api_token'] == '***'
    assert values['NESTED']['items'][0]['password'] == '***'
    assert values['NESTED']['ordinary'] == 'visible'
    assert dict(app.config) == before


def test_default_timedelta_and_help():
    app = Flask(__name__)
    assert isinstance(app.config['PERMANENT_SESSION_LIFETIME'], timedelta)
    group = FlaskGroup(create_app=lambda: app)
    result = CliRunner().invoke(group, ['config'])
    assert result.exit_code == 0, result.output
    assert 'PERMANENT_SESSION_LIFETIME' in json.loads(result.output)
    result = CliRunner().invoke(group, ['--help'])
    assert result.exit_code == 0
    assert 'config' in result.output
