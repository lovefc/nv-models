import { PROVIDER_NAME, qoderModelEntry, workbuddyModelsJsonEntry } from './clients.mjs';

const CLIENT_NAMES = {
  qoder: 'Qoder',
  workbuddy: 'WorkBuddy',
  'workbuddy-ai': 'WorkBuddy AI',
  zcode: 'ZCode',
};

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

const PYTHON = String.raw`
import base64
import json
import os
import pathlib
import shutil
import sys
import time
import uuid

CLIENT = os.environ.get('NV_MODELS_CLIENT', '')
PROVIDER_NAME = os.environ.get('NV_MODELS_PROVIDER', '')
BASE_URL = os.environ.get('NV_MODELS_BASE_URL', '').rstrip('/')
TOKEN = os.environ.get('NV_MODELS_TOKEN', '')
PAYLOAD = json.loads(base64.b64decode(os.environ.get('NV_MODELS_PAYLOAD_B64', '')).decode('utf-8'))
HOME = pathlib.Path.home()


def fail(message):
    print(message, file=sys.stderr)
    sys.exit(1)


def model_names(item):
    names = [item.get('short'), item.get('id')]
    aliases = item.get('aliases')
    if isinstance(aliases, list):
        names.extend(aliases)
    return [name for name in names if name]


def parse_jsonc(text):
    out = []
    in_string = False
    escaped = False
    line_comment = False
    block_comment = False
    comments = False
    index = 0
    while index < len(text):
        char = text[index]
        nxt = text[index + 1] if index + 1 < len(text) else ''
        if line_comment:
            if char in '\r\n':
                line_comment = False
                out.append(char)
            index += 1
            continue
        if block_comment:
            if char == '*' and nxt == '/':
                block_comment = False
                index += 2
                continue
            index += 1
            continue
        if in_string:
            out.append(char)
            if escaped:
                escaped = False
            elif char == '\\':
                escaped = True
            elif char == '"':
                in_string = False
            index += 1
            continue
        if char == '"':
            in_string = True
            out.append(char)
            index += 1
            continue
        if char == '/' and nxt == '/':
            line_comment = True
            comments = True
            index += 2
            continue
        if char == '/' and nxt == '*':
            block_comment = True
            comments = True
            index += 2
            continue
        out.append(char)
        index += 1

    joined = ''.join(out)
    stripped = []
    in_string = False
    escaped = False
    for index, char in enumerate(joined):
        if in_string:
            stripped.append(char)
            if escaped:
                escaped = False
            elif char == '\\':
                escaped = True
            elif char == '"':
                in_string = False
            continue
        if char == '"':
            in_string = True
            stripped.append(char)
            continue
        if char == ',':
            look = index + 1
            while look < len(joined) and joined[look].isspace():
                look += 1
            if look < len(joined) and joined[look] in '}]':
                continue
        stripped.append(char)
    try:
        value = json.loads(''.join(stripped) or '{}')
    except json.JSONDecodeError as error:
        raise ValueError('配置不是合法 JSON：' + str(error))
    return value, comments


def qoder_candidates():
    return [
        HOME / '.qoder-cn' / 'settings.json',
        HOME / '.qoder' / 'settings.json',
        HOME / '.config' / 'Qoder' / 'User' / 'settings.json',
        HOME / '.config' / 'qoder' / 'User' / 'settings.json',
    ]


def config_path():
    if CLIENT == 'qoder':
        candidates = qoder_candidates()
        for path in candidates:
            if path.exists():
                return path
        return candidates[0]
    if CLIENT == 'zcode':
        explicit = os.environ.get('ZCODE_PERSONAL_PROVIDER_CONFIG_FILE')
        if explicit:
            return pathlib.Path(explicit).expanduser()
        root = os.environ.get('ZCODE_HOME')
        if root:
            return pathlib.Path(root).expanduser() / 'v2' / 'provider_config.json'
        return HOME / '.zcode' / 'v2' / 'provider_config.json'
    if CLIENT == 'workbuddy-ai':
        value = os.environ.get('WORKBUDDY_AI_CONFIG_DIR')
        if value:
            return pathlib.Path(value).expanduser() / 'models.json'
        return HOME / '.workbuddy-ai' / 'models.json'
    for name in ('WORKBUDDY_CONFIG_DIR', 'CODEBUDDY_CONFIG_DIR'):
        value = os.environ.get(name)
        if value:
            return pathlib.Path(value).expanduser() / 'models.json'
    return HOME / '.workbuddy' / 'models.json'


def load_config(path):
    if not path.exists():
        return None, False
    text = path.read_text(encoding='utf-8-sig')
    if not text.strip():
        return {}, False
    data, comments = parse_jsonc(text)
    if CLIENT in ('workbuddy', 'workbuddy-ai') and isinstance(data, list):
        return data, comments
    if not isinstance(data, dict):
        raise ValueError('配置不是 JSON 对象：' + str(path))
    return data, comments


def prune(path):
    prefix = path.name + '.nv-models-backup-'
    try:
        files = sorted(path.parent.glob(prefix + '*'), key=lambda item: item.name, reverse=True)
        for old in files[5:]:
            old.unlink()
    except OSError:
        pass


def write_config(path, data):
    text = json.dumps(data, ensure_ascii=False, indent=2) + '\n'
    path.parent.mkdir(parents=True, exist_ok=True)
    mode = 0o600
    if path.exists():
        try:
            mode = path.stat().st_mode & 0o777
        except OSError:
            pass
        stamp = time.strftime('%Y-%m-%dT%H-%M-%S')
        backup = path.with_name(path.name + '.nv-models-backup-' + stamp + '.bak')
        index = 2
        while backup.exists():
            backup = path.with_name(path.name + '.nv-models-backup-' + stamp + '-' + str(index) + '.bak')
            index += 1
        shutil.copy2(path, backup)
        print('备份：' + str(backup))
        prune(path)
    temp = path.with_name(path.name + '.nv-models-' + str(os.getpid()) + '.tmp')
    temp.write_text(text, encoding='utf-8')
    try:
        os.chmod(temp, mode)
    except OSError:
        pass
    os.replace(temp, path)
    try:
        os.chmod(path, mode)
    except OSError:
        pass
    print('已写入配置：' + str(path))


def apply_qoder(data):
    providers = data.get('providers')
    if not isinstance(providers, dict):
        providers = {}
        data['providers'] = providers
    provider = None
    for item in providers.values():
        if isinstance(item, dict) and (item.get('nvModels') is True or item.get('displayName') == PROVIDER_NAME):
            provider = item
            break
    if provider is None:
        provider = {
            'baseUrl': BASE_URL + '/chat/completions' if BASE_URL else '',
            'apiKey': TOKEN or 'nv-local',
            'type': 'openai-compatible',
            'protocol': 'openai',
            'authType': 'bearer',
            'model': PAYLOAD[0]['short'] if PAYLOAD else '',
            'models': [],
            'displayName': PROVIDER_NAME,
            'nvModels': True,
        }
        providers['qoder-custom-' + str(uuid.uuid4())] = provider
    provider['baseUrl'] = BASE_URL + '/chat/completions' if BASE_URL else ''
    if TOKEN:
        provider['apiKey'] = TOKEN
    if not provider.get('apiKey'):
        provider['apiKey'] = 'nv-local'
    provider['displayName'] = PROVIDER_NAME
    provider['nvModels'] = True
    if not isinstance(provider.get('models'), list):
        provider['models'] = []
    models = provider['models']
    added = 0
    for item in PAYLOAD:
        short = item['short']
        names = model_names(item)
        hit = any(isinstance(entry, dict) and entry.get('model') in names for entry in models)
        if hit:
            continue
        models.append(item['entry'])
        added += 1
    current = provider.get('model')
    if not current or not any(isinstance(entry, dict) and entry.get('model') == current for entry in models):
        if PAYLOAD:
            provider['model'] = PAYLOAD[0]['short']
    return added


def same_gateway(value):
    left = str(value or '').strip().rstrip('/')
    if left.endswith('/chat/completions'):
        left = left[:-len('/chat/completions')]
    return bool(left) and left == BASE_URL.rstrip('/')


def apply_workbuddy(data):
    if isinstance(data, list):
        models = data
    else:
        models = data.get('models')
        if models is None:
            models = []
            data['models'] = models
        elif not isinstance(models, list):
            raise ValueError('WorkBuddy 的 models 不是数组')
    endpoint = BASE_URL + '/chat/completions'
    added = 0
    skipped = 0
    for item in PAYLOAD:
        short = item['short']
        names = model_names(item)
        entry = None
        for existing in models:
            if isinstance(existing, dict) and existing.get('id') in names:
                entry = existing
                break
        if entry is None:
            entry = dict(item['entry'])
            models.append(entry)
            added += 1
        elif not same_gateway(entry.get('url')):
            skipped += 1
            continue
        entry['url'] = endpoint
        if TOKEN:
            entry['apiKey'] = TOKEN
        elif not entry.get('apiKey'):
            entry['apiKey'] = 'nv-local'
    return added, skipped


def zcode_ensure(data):
    if not isinstance(data, dict):
        raise ValueError('ZCode 配置不是 JSON 对象')
    if not data.get('schemaVersion'):
        data['schemaVersion'] = 1
    config = data.get('config')
    if not isinstance(config, dict):
        config = {}
        data['config'] = config
    if not isinstance(config.get('providerOrder'), list):
        config['providerOrder'] = []
    provider_rules = config.get('providerConfigRules')
    if not isinstance(provider_rules, dict):
        provider_rules = {}
        config['providerConfigRules'] = provider_rules
    if not isinstance(provider_rules.get('providerRules'), list):
        provider_rules['providerRules'] = []
    model_rules = config.get('modelConfigRules')
    if not isinstance(model_rules, dict):
        model_rules = {}
        config['modelConfigRules'] = model_rules
    for key in ('providerModelRules', 'manualProviderModelRules'):
        if not isinstance(model_rules.get(key), list):
            model_rules[key] = []
    return config


def apply_zcode(data):
    config = zcode_ensure(data)
    rules = config['providerConfigRules']['providerRules']
    provider = None
    for rule in rules:
        if isinstance(rule, dict) and (rule.get('providerName') == PROVIDER_NAME or rule.get('providerId') == 'nv-models'):
            provider = rule
            break
    if provider is None:
        provider_id = 'nv-models'
        used = {str(rule.get('providerId')) for rule in rules if isinstance(rule, dict)}
        index = 2
        while provider_id in used:
            provider_id = 'nv-models-' + str(index)
            index += 1
        provider = {
            'providerId': provider_id,
            'providerName': PROVIDER_NAME,
            'config': {
                'group': 'standard-personal',
                'access': {'type': 'api-key'},
                'api': {'type': 'openai-chat-completions'},
                'personalModelIds': [],
                'modelOrder': [],
            },
        }
        rules.append(provider)
    if provider['providerId'] not in config['providerOrder']:
        config['providerOrder'].append(provider['providerId'])
    provider['providerName'] = PROVIDER_NAME
    rule_config = provider.get('config')
    if not isinstance(rule_config, dict):
        rule_config = {}
        provider['config'] = rule_config
    if not rule_config.get('group'):
        rule_config['group'] = 'standard-personal'
    access = rule_config.get('access')
    if not isinstance(access, dict):
        access = {}
        rule_config['access'] = access
    access['type'] = 'api-key'
    if TOKEN:
        access['apiKey'] = TOKEN
    elif not access.get('apiKey'):
        access['apiKey'] = 'nv-local'
    api = rule_config.get('api')
    if not isinstance(api, dict):
        api = {}
        rule_config['api'] = api
    api['type'] = 'openai-chat-completions'
    if BASE_URL:
        api['baseUrl'] = BASE_URL
    ids = rule_config.get('personalModelIds')
    if not isinstance(ids, list):
        ids = []
        rule_config['personalModelIds'] = ids
    added = 0
    for item in PAYLOAD:
        names = model_names(item)
        if any(name in ids for name in names):
            continue
        ids.append(item['short'])
        added += 1
    order = rule_config.get('modelOrder')
    if not isinstance(order, list):
        order = []
    for model_id in ids:
        if model_id not in order:
            order.append(model_id)
    rule_config['modelOrder'] = [model_id for model_id in order if model_id in ids]
    return added


def main():
    if CLIENT not in ('qoder', 'workbuddy', 'workbuddy-ai', 'zcode'):
        fail('未知客户端：' + CLIENT)
    if not BASE_URL:
        fail('缺少网关地址，无法生成客户端配置')
    if not PAYLOAD:
        fail('没有可添加的模型')

    path = config_path()
    data, comments = load_config(path)
    if data is None:
        if CLIENT == 'qoder':
            data = {'providers': {}}
        elif CLIENT == 'zcode':
            data = {}
        else:
            data = {'models': []}

    skipped = 0
    if CLIENT == 'qoder':
        added = apply_qoder(data)
        name = 'Qoder'
        detected = any((HOME / item).exists() for item in ('.qoder-cn', '.qoder')) or \
            (HOME / '.config' / 'Qoder').exists() or (HOME / '.config' / 'qoder').exists()
    elif CLIENT in ('workbuddy', 'workbuddy-ai'):
        added, skipped = apply_workbuddy(data)
        if CLIENT == 'workbuddy-ai':
            name = 'WorkBuddy AI'
            folder = '.workbuddy-ai'
            explicit = os.environ.get('WORKBUDDY_AI_CONFIG_DIR')
        else:
            name = 'WorkBuddy'
            folder = '.workbuddy'
            explicit = os.environ.get('WORKBUDDY_CONFIG_DIR') or os.environ.get('CODEBUDDY_CONFIG_DIR')
        detected = path.parent.exists() or (HOME / folder).exists() or bool(explicit)
    else:
        added = apply_zcode(data)
        name = 'ZCode'
        detected = path.parent.exists() or (HOME / '.zcode').exists() or \
            bool(os.environ.get('ZCODE_HOME') or os.environ.get('ZCODE_PERSONAL_PROVIDER_CONFIG_FILE'))

    total = len(PAYLOAD)
    write_config(path, data)
    print('')
    print(name + '：新增 ' + str(added) + ' 个模型，已存在 ' + str(total - added - skipped) + ' 个，共 ' + str(total) + ' 个')
    if skipped:
        print('提示：' + str(skipped) + ' 个同名模型指向其他服务，已跳过，未覆盖。')
    if not detected:
        print('提示：未检测到 ' + name + ' 的安装目录，已按默认路径创建配置；如未安装可忽略。')
    if comments:
        print('提示：原配置含注释，写入后变成标准 JSON；已保留备份。')
    if added:
        print('提示：重启 ' + name + ' 后可在模型列表里看到。')


try:
    main()
except SystemExit:
    raise
except Exception as error:
    fail('写入失败：' + str(error))
`;

const POWERSHELL = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ProviderName = 'NVIDIA Free (nv-models)'

function ConvertTo-Hashtable($Value) {
  if ($null -eq $Value) { return $null }
  if ($Value -is [System.Management.Automation.PSCustomObject]) {
    $map = @{}
    foreach ($property in $Value.PSObject.Properties) {
      $map[$property.Name] = ConvertTo-Hashtable $property.Value
    }
    return $map
  }
  if ($Value -is [System.Array]) {
    $list = New-Object System.Collections.ArrayList
    foreach ($item in $Value) {
      [void]$list.Add((ConvertTo-Hashtable $item))
    }
    return ,$list
  }
  return $Value
}

function To-List($Value) {
  $list = New-Object System.Collections.ArrayList
  if ($null -ne $Value) {
    foreach ($item in @($Value)) { [void]$list.Add($item) }
  }
  return ,$list
}

function Convert-JsoncToJson([string]$Text) {
  $builder = New-Object System.Text.StringBuilder
  $inString = $false
  $escaped = $false
  $lineComment = $false
  $blockComment = $false
  $hadComments = $false
  for ($i = 0; $i -lt $Text.Length; $i++) {
    $char = $Text[$i]
    if ($i + 1 -lt $Text.Length) { $next = $Text[$i + 1] } else { $next = [char]0 }
    if ($lineComment) {
      if (($char -eq [char]13) -or ($char -eq [char]10)) {
        $lineComment = $false
        [void]$builder.Append($char)
      }
      continue
    }
    if ($blockComment) {
      if (($char -eq [char]42) -and ($next -eq [char]47)) {
        $blockComment = $false
        $i += 1
      }
      continue
    }
    if ($inString) {
      [void]$builder.Append($char)
      if ($escaped) { $escaped = $false }
      elseif ($char -eq [char]92) { $escaped = $true }
      elseif ($char -eq [char]34) { $inString = $false }
      continue
    }
    if ($char -eq [char]34) {
      $inString = $true
      [void]$builder.Append($char)
      continue
    }
    if (($char -eq [char]47) -and ($next -eq [char]47)) {
      $hadComments = $true
      $lineComment = $true
      $i += 1
      continue
    }
    if (($char -eq [char]47) -and ($next -eq [char]42)) {
      $hadComments = $true
      $blockComment = $true
      $i += 1
      continue
    }
    [void]$builder.Append($char)
  }

  $joined = $builder.ToString()
  $output = New-Object System.Text.StringBuilder
  $inString = $false
  $escaped = $false
  for ($i = 0; $i -lt $joined.Length; $i++) {
    $char = $joined[$i]
    if ($inString) {
      [void]$output.Append($char)
      if ($escaped) { $escaped = $false }
      elseif ($char -eq [char]92) { $escaped = $true }
      elseif ($char -eq [char]34) { $inString = $false }
      continue
    }
    if ($char -eq [char]34) {
      $inString = $true
      [void]$output.Append($char)
      continue
    }
    if ($char -eq [char]44) {
      $look = $i + 1
      while (($look -lt $joined.Length) -and [char]::IsWhiteSpace($joined[$look])) { $look += 1 }
      if (($look -lt $joined.Length) -and (($joined[$look] -eq [char]125) -or ($joined[$look] -eq [char]93))) {
        continue
      }
    }
    [void]$output.Append($char)
  }
  return @{ Text = $output.ToString(); HadComments = $hadComments }
}

function Read-JsonFile([string]$Path, [bool]$AllowArray) {
  if (-not (Test-Path -LiteralPath $Path)) {
    return @{ Exists = $false; Data = $null; HadComments = $false }
  }
  $text = [IO.File]::ReadAllText($Path, [Text.Encoding]::UTF8)
  if (-not $text.Trim()) {
    return @{ Exists = $true; Data = @{}; HadComments = $false }
  }
  $parsed = Convert-JsoncToJson $text
  $data = ConvertTo-Hashtable (ConvertFrom-Json $parsed.Text)
  if ($AllowArray) {
    if (-not (($data -is [hashtable]) -or ($data -is [System.Collections.ArrayList]))) {
      throw ('配置不是 JSON 对象或数组：' + $Path)
    }
  } elseif (-not ($data -is [hashtable])) {
    throw ('配置不是 JSON 对象：' + $Path)
  }
  return @{ Exists = $true; Data = $data; HadComments = $parsed.HadComments }
}

function Format-Json([string]$Json) {
  $builder = New-Object System.Text.StringBuilder
  $indent = 0
  $inString = $false
  $escaped = $false
  for ($i = 0; $i -lt $Json.Length; $i++) {
    $char = $Json[$i]
    if ($inString) {
      [void]$builder.Append($char)
      if ($escaped) { $escaped = $false }
      elseif ($char -eq [char]92) { $escaped = $true }
      elseif ($char -eq [char]34) { $inString = $false }
      continue
    }
    if ($char -eq [char]34) {
      $inString = $true
      [void]$builder.Append($char)
      continue
    }
    if (($char -eq [char]123) -or ($char -eq [char]91)) {
      $look = $i + 1
      $empty = $false
      if ($look -lt $Json.Length) {
        if (($char -eq [char]123) -and ($Json[$look] -eq [char]125)) { $empty = $true }
        if (($char -eq [char]91) -and ($Json[$look] -eq [char]93)) { $empty = $true }
      }
      [void]$builder.Append($char)
      if ($empty) {
        if ($char -eq [char]123) { [void]$builder.Append([char]125) } else { [void]$builder.Append([char]93) }
        $i = $look
        continue
      }
      $indent += 1
      [void]$builder.Append([char]10)
      [void]$builder.Append((' ' * (2 * $indent)))
      continue
    }
    if (($char -eq [char]125) -or ($char -eq [char]93)) {
      $indent -= 1
      if ($indent -lt 0) { $indent = 0 }
      [void]$builder.Append([char]10)
      [void]$builder.Append((' ' * (2 * $indent)))
      [void]$builder.Append($char)
      continue
    }
    if ($char -eq [char]44) {
      [void]$builder.Append($char)
      [void]$builder.Append([char]10)
      [void]$builder.Append((' ' * (2 * $indent)))
      continue
    }
    if ($char -eq [char]58) {
      [void]$builder.Append(': ')
      continue
    }
    if ([char]::IsWhiteSpace($char)) { continue }
    [void]$builder.Append($char)
  }
  return $builder.ToString()
}

function Write-JsonFile([string]$Path, $Data) {
  $directory = Split-Path -Parent $Path
  if ($directory -and (-not (Test-Path -LiteralPath $directory))) {
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
  }
  if (Test-Path -LiteralPath $Path) {
    $stamp = Get-Date -Format 'yyyy-MM-ddTHH-mm-ss'
    $backup = ($Path + '.nv-models-backup-' + $stamp + '.bak')
    $index = 2
    while (Test-Path -LiteralPath $backup) {
      $backup = ($Path + '.nv-models-backup-' + $stamp + '-' + $index + '.bak')
      $index += 1
    }
    Copy-Item -LiteralPath $Path -Destination $backup -Force
    Write-Host ('备份：' + $backup)
    $pattern = ((Split-Path -Leaf $Path) + '.nv-models-backup-*')
    $backups = @(Get-ChildItem -LiteralPath $directory -Filter $pattern | Sort-Object Name -Descending)
    if ($backups.Count -gt 5) {
      $backups | Select-Object -Skip 5 | ForEach-Object {
        Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue
      }
    }
  }
  $compact = ConvertTo-Json -InputObject $Data -Depth 100 -Compress
  $text = (Format-Json $compact) + [char]10
  $temp = ($Path + '.nv-models-' + $PID + '.tmp')
  [IO.File]::WriteAllText($temp, $text, (New-Object System.Text.UTF8Encoding($false)))
  Move-Item -LiteralPath $temp -Destination $Path -Force
  Write-Host ('已写入配置：' + $Path)
}

function Get-GatewayRoot([string]$Value) {
  $text = ([string]$Value).Trim().TrimEnd('/')
  return [regex]::Replace($text, '/chat/completions$', '', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
}

function Test-SameGateway([string]$Value) {
  return ((Get-GatewayRoot $Value) -eq $GatewayRootUrl)
}

function Get-QoderPath {
  $candidates = New-Object System.Collections.ArrayList
  [void]$candidates.Add((Join-Path $HomeDir '.qoder-cn\settings.json'))
  [void]$candidates.Add((Join-Path $HomeDir '.qoder\settings.json'))
  [void]$candidates.Add((Join-Path $HomeDir '.config\Qoder\User\settings.json'))
  [void]$candidates.Add((Join-Path $HomeDir '.config\qoder\User\settings.json'))
  if ($env:APPDATA) {
    [void]$candidates.Add((Join-Path $env:APPDATA 'Qoder\User\settings.json'))
    [void]$candidates.Add((Join-Path $env:APPDATA 'qoder\User\settings.json'))
  }
  foreach ($path in $candidates) {
    if (Test-Path -LiteralPath $path) { return $path }
  }
  return $candidates[0]
}

function Get-WorkbuddyPath([bool]$International) {
  if ($International) {
    if ($env:WORKBUDDY_AI_CONFIG_DIR) {
      return (Join-Path $env:WORKBUDDY_AI_CONFIG_DIR 'models.json')
    }
    return (Join-Path $HomeDir '.workbuddy-ai\models.json')
  }
  $dir = $env:WORKBUDDY_CONFIG_DIR
  if (-not $dir) { $dir = $env:CODEBUDDY_CONFIG_DIR }
  if ($dir) { return (Join-Path $dir 'models.json') }
  return (Join-Path $HomeDir '.workbuddy\models.json')
}

function Get-ZcodePath {
  if ($env:ZCODE_PERSONAL_PROVIDER_CONFIG_FILE) {
    return $env:ZCODE_PERSONAL_PROVIDER_CONFIG_FILE
  }
  if ($env:ZCODE_HOME) {
    return (Join-Path $env:ZCODE_HOME 'v2\provider_config.json')
  }
  return (Join-Path $HomeDir '.zcode\v2\provider_config.json')
}

function Apply-Qoder($Data) {
  if (-not ($Data -is [hashtable])) { throw 'Qoder 配置不是 JSON 对象' }
  if (-not ($Data['providers'] -is [hashtable])) { $Data['providers'] = @{} }
  $providers = $Data['providers']
  $provider = $null
  foreach ($key in @($providers.Keys)) {
    $item = $providers[$key]
    if (($item -is [hashtable]) -and (($item['nvModels'] -eq $true) -or ($item['displayName'] -eq $ProviderName))) {
      $provider = $item
      break
    }
  }
  if ($null -eq $provider) {
    $provider = @{
      baseUrl = $ChatEndpoint
      apiKey = $(if ($Token) { $Token } else { 'nv-local' })
      type = 'openai-compatible'
      protocol = 'openai'
      authType = 'bearer'
      model = $(if ($Payload.Count -gt 0) { [string]$Payload[0]['short'] } else { '' })
      models = (New-Object System.Collections.ArrayList)
      displayName = $ProviderName
      nvModels = $true
    }
    $providers[('qoder-custom-' + [guid]::NewGuid().ToString())] = $provider
  }
  $provider['baseUrl'] = $ChatEndpoint
  if ($Token) { $provider['apiKey'] = $Token }
  if (-not $provider['apiKey']) { $provider['apiKey'] = 'nv-local' }
  $provider['displayName'] = $ProviderName
  $provider['nvModels'] = $true
  if (-not ($provider['models'] -is [System.Collections.ArrayList])) {
    $provider['models'] = (To-List $provider['models'])
  }
  $models = $provider['models']
  $added = 0
  foreach ($item in $Payload) {
    $names = @([string]$item['short'], [string]$item['id'])
    foreach ($alias in @($item['aliases'])) {
      if ($alias) { $names += [string]$alias }
    }
    $hit = $false
    foreach ($entry in @($models)) {
      if (($entry -is [hashtable]) -and ($names -contains [string]$entry['model'])) {
        $hit = $true
        break
      }
    }
    if ($hit) { continue }
    [void]$models.Add((ConvertTo-Hashtable $item['entry']))
    $added += 1
  }
  $current = [string]$provider['model']
  $found = $false
  foreach ($entry in @($models)) {
    if (($entry -is [hashtable]) -and ([string]$entry['model'] -eq $current)) {
      $found = $true
      break
    }
  }
  if ((-not $current) -or (-not $found)) {
    if ($Payload.Count -gt 0) { $provider['model'] = [string]$Payload[0]['short'] }
  }
  return $added
}

function Apply-Workbuddy($Data) {
  if ($Data -is [System.Collections.ArrayList]) {
    $models = $Data
  } elseif ($Data -is [hashtable]) {
    if (-not ($Data['models'] -is [System.Collections.ArrayList])) {
      $Data['models'] = (To-List $Data['models'])
    }
    $models = $Data['models']
  } else {
    throw 'WorkBuddy 配置不是 JSON 对象或数组'
  }
  $added = 0
  $skipped = 0
  foreach ($item in $Payload) {
    $names = @([string]$item['short'], [string]$item['id'])
    foreach ($alias in @($item['aliases'])) {
      if ($alias) { $names += [string]$alias }
    }
    $entry = $null
    foreach ($existing in @($models)) {
      if (($existing -is [hashtable]) -and ($names -contains [string]$existing['id'])) {
        $entry = $existing
        break
      }
    }
    if ($null -eq $entry) {
      $entry = ConvertTo-Hashtable $item['entry']
      $entry['url'] = $ChatEndpoint
      $entry['apiKey'] = $(if ($Token) { $Token } else { 'nv-local' })
      [void]$models.Add($entry)
      $added += 1
    } elseif (-not (Test-SameGateway ([string]$entry['url']))) {
      $skipped += 1
    } else {
      $entry['url'] = $ChatEndpoint
      if ($Token) {
        $entry['apiKey'] = $Token
      } elseif (-not $entry['apiKey']) {
        $entry['apiKey'] = 'nv-local'
      }
    }
  }
  return @{ Added = $added; Skipped = $skipped }
}

function Ensure-ZcodeConfig($Data) {
  if (-not ($Data -is [hashtable])) { throw 'ZCode 配置不是 JSON 对象' }
  if (-not $Data['schemaVersion']) { $Data['schemaVersion'] = 1 }
  if (-not ($Data['config'] -is [hashtable])) { $Data['config'] = @{} }
  $config = $Data['config']
  if (-not ($config['providerOrder'] -is [System.Collections.ArrayList])) {
    $config['providerOrder'] = (To-List $config['providerOrder'])
  }
  if (-not ($config['providerConfigRules'] -is [hashtable])) { $config['providerConfigRules'] = @{} }
  $ruleRoot = $config['providerConfigRules']
  if (-not ($ruleRoot['providerRules'] -is [System.Collections.ArrayList])) {
    $ruleRoot['providerRules'] = (To-List $ruleRoot['providerRules'])
  }
  if (-not ($config['modelConfigRules'] -is [hashtable])) { $config['modelConfigRules'] = @{} }
  $modelRules = $config['modelConfigRules']
  foreach ($key in @('providerModelRules', 'manualProviderModelRules')) {
    if (-not ($modelRules[$key] -is [System.Collections.ArrayList])) {
      $modelRules[$key] = (To-List $modelRules[$key])
    }
  }
  return $config
}

function Apply-Zcode($Data) {
  $config = Ensure-ZcodeConfig $Data
  $rules = $config['providerConfigRules']['providerRules']
  $provider = $null
  foreach ($rule in @($rules)) {
    if (($rule -is [hashtable]) -and (($rule['providerName'] -eq $ProviderName) -or ($rule['providerId'] -eq 'nv-models'))) {
      $provider = $rule
      break
    }
  }
  if ($null -eq $provider) {
    $providerId = 'nv-models'
    $used = @{}
    foreach ($rule in @($rules)) {
      if ($rule -is [hashtable]) { $used[[string]$rule['providerId']] = $true }
    }
    $index = 2
    while ($used.ContainsKey($providerId)) {
      $providerId = ('nv-models-' + $index)
      $index += 1
    }
    $provider = @{
      providerId = $providerId
      providerName = $ProviderName
      config = @{
        group = 'standard-personal'
        access = @{ type = 'api-key' }
        api = @{ type = 'openai-chat-completions' }
        personalModelIds = (New-Object System.Collections.ArrayList)
        modelOrder = (New-Object System.Collections.ArrayList)
      }
    }
    [void]$rules.Add($provider)
  }
  $currentId = [string]$provider['providerId']
  $order = $config['providerOrder']
  $hasOrder = $false
  foreach ($id in @($order)) {
    if ([string]$id -eq $currentId) {
      $hasOrder = $true
      break
    }
  }
  if (-not $hasOrder) { [void]$order.Add($currentId) }
  $provider['providerName'] = $ProviderName
  if (-not ($provider['config'] -is [hashtable])) { $provider['config'] = @{} }
  $ruleConfig = $provider['config']
  if (-not $ruleConfig['group']) { $ruleConfig['group'] = 'standard-personal' }
  if (-not ($ruleConfig['access'] -is [hashtable])) { $ruleConfig['access'] = @{} }
  $access = $ruleConfig['access']
  $access['type'] = 'api-key'
  if ($Token) {
    $access['apiKey'] = $Token
  } elseif (-not $access['apiKey']) {
    $access['apiKey'] = 'nv-local'
  }
  if (-not ($ruleConfig['api'] -is [hashtable])) { $ruleConfig['api'] = @{} }
  $api = $ruleConfig['api']
  $api['type'] = 'openai-chat-completions'
  if ($BaseUrl) { $api['baseUrl'] = $BaseUrl }
  if (-not ($ruleConfig['personalModelIds'] -is [System.Collections.ArrayList])) {
    $ruleConfig['personalModelIds'] = (To-List $ruleConfig['personalModelIds'])
  }
  $ids = $ruleConfig['personalModelIds']
  $added = 0
  foreach ($item in $Payload) {
    $names = @([string]$item['short'], [string]$item['id'])
    foreach ($alias in @($item['aliases'])) {
      if ($alias) { $names += [string]$alias }
    }
    $hit = $false
    foreach ($id in @($ids)) {
      if ($names -contains [string]$id) {
        $hit = $true
        break
      }
    }
    if ($hit) { continue }
    [void]$ids.Add([string]$item['short'])
    $added += 1
  }
  if (-not ($ruleConfig['modelOrder'] -is [System.Collections.ArrayList])) {
    $ruleConfig['modelOrder'] = (To-List $ruleConfig['modelOrder'])
  }
  $orderList = $ruleConfig['modelOrder']
  foreach ($id in @($ids)) {
    $exists = $false
    foreach ($current in @($orderList)) {
      if ([string]$current -eq [string]$id) {
        $exists = $true
        break
      }
    }
    if (-not $exists) { [void]$orderList.Add($id) }
  }
  $filtered = New-Object System.Collections.ArrayList
  foreach ($id in @($orderList)) {
    foreach ($keep in @($ids)) {
      if ([string]$id -eq [string]$keep) {
        [void]$filtered.Add($id)
        break
      }
    }
  }
  $ruleConfig['modelOrder'] = $filtered
  return $added
}

$Config = ConvertTo-Hashtable (ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__NV_MODELS_CONFIG__'))))
$HomeDir = $env:USERPROFILE
if (-not $HomeDir) { $HomeDir = $HOME }
if (-not $HomeDir) { throw '找不到用户目录' }

$Client = [string]$Config['client']
$BaseUrl = ([string]$Config['baseUrl']).TrimEnd('/')
$Token = [string]$Config['token']
$Payload = @($Config['payload'])
$ChatEndpoint = $(if ($BaseUrl) { $BaseUrl + '/chat/completions' } else { '' })
$GatewayRootUrl = Get-GatewayRoot $BaseUrl

try {
  if (-not $BaseUrl) { throw '缺少网关地址，无法生成客户端配置' }
  if ($Payload.Count -eq 0) { throw '没有可添加的模型' }

  $skipped = 0
  $comments = $false
  $detected = $false
  switch ($Client) {
    'qoder' {
      $path = Get-QoderPath
      $parsed = Read-JsonFile $path $false
      if ($parsed.Exists) { $data = $parsed.Data } else { $data = @{ providers = @{} } }
      if (-not ($data -is [hashtable])) { throw 'Qoder 配置不是 JSON 对象' }
      $added = Apply-Qoder $data
      $comments = $parsed.HadComments
      $name = 'Qoder'
      $detected = (Test-Path -LiteralPath (Join-Path $HomeDir '.qoder-cn')) -or
        (Test-Path -LiteralPath (Join-Path $HomeDir '.qoder')) -or
        (Test-Path -LiteralPath (Join-Path $HomeDir '.config\Qoder')) -or
        (Test-Path -LiteralPath (Join-Path $HomeDir '.config\qoder')) -or
        ($env:APPDATA -and (Test-Path -LiteralPath (Join-Path $env:APPDATA 'Qoder')))
    }
    'workbuddy' {
      $path = Get-WorkbuddyPath $false
      $parsed = Read-JsonFile $path $true
      if ($parsed.Exists) { $data = $parsed.Data } else { $data = @{ models = (New-Object System.Collections.ArrayList) } }
      $result = Apply-Workbuddy $data
      $added = $result.Added
      $skipped = $result.Skipped
      $comments = $parsed.HadComments
      $name = 'WorkBuddy'
      $explicit = ($env:WORKBUDDY_CONFIG_DIR -or $env:CODEBUDDY_CONFIG_DIR)
      $detected = (Test-Path -LiteralPath (Split-Path -Parent $path)) -or
        (Test-Path -LiteralPath (Join-Path $HomeDir '.workbuddy')) -or
        [bool]$explicit
    }
    'workbuddy-ai' {
      $path = Get-WorkbuddyPath $true
      $parsed = Read-JsonFile $path $true
      if ($parsed.Exists) { $data = $parsed.Data } else { $data = @{ models = (New-Object System.Collections.ArrayList) } }
      $result = Apply-Workbuddy $data
      $added = $result.Added
      $skipped = $result.Skipped
      $comments = $parsed.HadComments
      $name = 'WorkBuddy AI'
      $explicit = $env:WORKBUDDY_AI_CONFIG_DIR
      $detected = (Test-Path -LiteralPath (Split-Path -Parent $path)) -or
        (Test-Path -LiteralPath (Join-Path $HomeDir '.workbuddy-ai')) -or
        [bool]$explicit
    }
    'zcode' {
      $path = Get-ZcodePath
      $parsed = Read-JsonFile $path $false
      if ($parsed.Exists) { $data = $parsed.Data } else { $data = @{} }
      $added = Apply-Zcode $data
      $comments = $parsed.HadComments
      $name = 'ZCode'
      $explicit = ($env:ZCODE_HOME -or $env:ZCODE_PERSONAL_PROVIDER_CONFIG_FILE)
      $detected = (Test-Path -LiteralPath (Split-Path -Parent $path)) -or
        (Test-Path -LiteralPath (Join-Path $HomeDir '.zcode')) -or
        [bool]$explicit
    }
    default { throw ('未知客户端：' + $Client) }
  }

  Write-JsonFile $path $data
  Write-Host ''
  Write-Host ($name + '：新增 ' + $added + ' 个模型，已存在 ' + ($Payload.Count - $added - $skipped) + ' 个，共 ' + $Payload.Count + ' 个')
  if ($skipped -gt 0) {
    Write-Host ('提示：' + $skipped + ' 个同名模型指向其他服务，已跳过，未覆盖。')
  }
  if (-not $detected) {
    Write-Host ('提示：未检测到 ' + $name + ' 的安装目录，已按默认路径创建配置；如未安装可忽略。')
  }
  if ($comments) {
    Write-Host '提示：原配置含注释，写入后变成标准 JSON；已保留备份。'
  }
  if ($added -gt 0) {
    Write-Host ('提示：重启 ' + $name + ' 后可在模型列表里看到。')
  }
  exit 0
} catch {
  Write-Host ('写入失败：' + $_.Exception.Message)
  exit 1
}
`;

const POWERSHELL_BATCH = [
  '@echo off',
  'chcp 65001 >nul',
  'setlocal',
  'set "NV_MODELS_SCRIPT=%~f0"',
  'powershell -NoProfile -ExecutionPolicy Bypass -Command "$raw=Get-Content -LiteralPath $env:NV_MODELS_SCRIPT -Raw -Encoding UTF8; $begin=\'##PS\'+\'-BEGIN##\'; $end=\'##PS\'+\'-END##\'; if($raw -match (\'(?s)\'+[regex]::Escape($begin)+\'(.*?)\'+[regex]::Escape($end))){[ScriptBlock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(($matches[1] -replace \'\\s\',\'\')))).Invoke()}else{Write-Host \'脚本内容损坏\'; exit 1}"',
  'set "NV_MODELS_EXIT=%ERRORLEVEL%"',
  'echo.',
  'pause',
  'goto :NV_MODELS_END',
  '##PS-BEGIN##',
  '__NV_MODELS_B64__',
  '##PS-END##',
  ':NV_MODELS_END',
  'exit /b %NV_MODELS_EXIT%',
  '',
];

function buildBatchScript({ client, payload, baseUrl, token }) {
  const config = Buffer.from(
    JSON.stringify({
      client,
      baseUrl: String(baseUrl || '').replace(/\/+$/, ''),
      token: token || '',
      payload,
    }),
    'utf8',
  ).toString('base64');
  const script = POWERSHELL.replace('__NV_MODELS_CONFIG__', config);
  const encoded = Buffer.from(script, 'utf8').toString('base64');
  const lines = encoded.match(/.{1,110}/g) || [];
  return POWERSHELL_BATCH.flatMap((line) =>
    line === '__NV_MODELS_B64__' ? lines : [line],
  ).join('\r\n');
}

function safeFileSegment(value) {
  return String(value || '')
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 80);
}

export function setupScriptFileName({ client, model, all = false, format = 'sh' }) {
  const slug = all ? 'all' : safeFileSegment(model) || 'model';
  const extension = String(format).toLowerCase() === 'bat' ? 'bat' : 'sh';
  return `nv-${client}-${slug}.${extension}`;
}

export function buildSetupScript({ client, models, baseUrl, token, format = 'sh', fileName = '' }) {
  const name = CLIENT_NAMES[client];
  if (!name) throw new Error(`未知客户端：${client}`);
  const list = Array.isArray(models) ? models : [];
  if (!list.length) throw new Error('没有可添加的模型');

  const payload = list.map((model) => ({
    short: model.short,
    id: model.id,
    aliases: Array.isArray(model.aliases) ? model.aliases : [model.short],
    entry:
      client === 'qoder'
        ? qoderModelEntry(model)
        : client === 'workbuddy' || client === 'workbuddy-ai'
          ? workbuddyModelsJsonEntry(model)
          : null,
  }));
  if (String(format).toLowerCase() === 'bat') {
    return buildBatchScript({ client, payload, baseUrl, token });
  }

  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
  const generatedAt = new Date().toISOString();

  return [
    '#!/usr/bin/env bash',
    `# nv-models 本地配置脚本（Linux / macOS）`,
    `# 目标客户端：${name}`,
    `# 模型数量：${list.length}`,
    `# 生成时间：${generatedAt}`,
    `# 用法：bash ${fileName || `nv-${client}.sh`}`,
    '# 脚本包含 API Token，写入完成后请删除本文件。',
    'set -euo pipefail',
    '',
    'if ! command -v python3 >/dev/null 2>&1; then',
    '  echo "需要 python3：请先安装（例如 sudo apt install python3），或按网页里的地址手动填写。" >&2',
    '  exit 1',
    'fi',
    '',
    `NV_MODELS_CLIENT=${shellQuote(client)} \\`,
    `NV_MODELS_PROVIDER=${shellQuote(PROVIDER_NAME)} \\`,
    `NV_MODELS_BASE_URL=${shellQuote(String(baseUrl || '').replace(/\/+$/, ''))} \\`,
    `NV_MODELS_TOKEN=${shellQuote(token || '')} \\`,
    `NV_MODELS_PAYLOAD_B64=${shellQuote(encoded)} \\`,
    "python3 <<'NV_MODELS_PY'",
    PYTHON.trimEnd(),
    'NV_MODELS_PY',
    '',
  ].join('\n');
}
