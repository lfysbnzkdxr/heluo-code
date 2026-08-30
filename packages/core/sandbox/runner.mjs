// heluo-code sandbox runner（Windows 沙箱执行器）
//
// 用法：node runner.mjs --mode <job|restricted> --workspace <abs> [--writable-root <abs>]... -- <argv...>
//
// 模式：
//   job        —— 普通进程 + KILL_ON_JOB_CLOSE Job Object（进程树 OS 必杀 + 活动进程上限 16），
//                 无需特权（CreateProcessW + JOB_LIST 属性，EXTENDED_STARTUPINFO_PRESENT）
//   restricted —— 当前用户 token → CreateRestrictedToken(WRITE_RESTRICTED)，restricting SIDs =
//                 [workspaceSID, tempSID, logonSID, Everyone]（后两者为 keep-alive，缺失导致 DLL
//                 初始化 0xC0000142）。写类访问做双检查：只能写被授予 ACE 的
//                 workspace/temp/writableRoots，其余路径写被 OS 拒绝。进程以 CREATE_SUSPENDED
//                 创建 → AssignProcessToJobObject（KILL_ON_JOB_CLOSE）→ ResumeThread。
//                 **需特权**（CreateProcessAsUserW 要求 SE_INCREASE_QUOTA，restricted 仅豁免
//                 SE_ASSIGNPRIMARYTOKEN；普通用户环境不可用，由 sandbox 服务降级为 job）。
//
//   任何 API 失败 → stderr 打印 "sandbox-run: <detail>" 并 exit 127（fail-closed，绝不无沙箱执行）。
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import koffi from 'koffi'

const kernel32 = koffi.load('kernel32.dll')
const advapi32 = koffi.load('advapi32.dll')

// ---------- 常量 ----------
const TOKEN_ASSIGN_PRIMARY = 0x0001
const TOKEN_DUPLICATE = 0x0002
const TOKEN_QUERY = 0x0008
const TOKEN_ADJUST_DEFAULT = 0x0010
const DISABLE_MAX_PRIVILEGE = 0x1
const LUA_TOKEN = 0x4
const WRITE_RESTRICTED = 0x8
const TokenGroups = 2
const SE_GROUP_LOGON_ID = 0xc0000000
const SE_FILE_OBJECT = 1
const DACL_SECURITY_INFORMATION = 0x4
const GRANT_ACCESS = 1
const TRUSTEE_IS_SID = 0
const TRUSTEE_IS_UNKNOWN = 0
const CONTAINER_INHERIT_ACE = 0x2
const OBJECT_INHERIT_ACE = 0x1
const FILE_GENERIC_WRITE = 0x00120116
const STARTF_USESTDHANDLES = 0x100
const KILL_ON_JOB_CLOSE = 0x2000
const CREATE_SUSPENDED = 0x4
const EXTENDED_STARTUPINFO_PRESENT = 0x00080000
const HANDLE_FLAG_INHERIT = 0x1
const STD_INPUT_HANDLE = -10
const STD_OUTPUT_HANDLE = -11
const STD_ERROR_HANDLE = -12
const ACCESS_ALLOWED_ACE_TYPE = 0
const ACTIVE_PROCESS_LIMIT = 16
const TOKEN_GROUPS_MAX = 64
const PROC_THREAD_ATTRIBUTE_JOB_LIST = 0x2000d
const JobObjectExtendedLimitInformation = 9

// ---------- koffi 类型（koffi 3 指针 = BigInt） ----------
const PVOID = koffi.pointer('void')
const PPVOID = koffi.pointer(PVOID)
const SID_AND_ATTRIBUTES = koffi.struct('SID_AND_ATTRIBUTES', { Sid: PVOID, Attributes: 'uint32' })
const TRUSTEE_W = koffi.struct('TRUSTEE_W', {
  pMultipleTrustee: PVOID,
  MultipleTrusteeOperation: 'uint32',
  TrusteeForm: 'uint32',
  TrusteeType: 'uint32',
  ptstrName: PVOID,
})
const EXPLICIT_ACCESS_W = koffi.struct('EXPLICIT_ACCESS_W', {
  grfAccessPermissions: 'uint32',
  grfAccessMode: 'int32',
  grfInheritance: 'uint32',
  Trustee: TRUSTEE_W,
})
const STARTUPINFOW = koffi.struct('STARTUPINFOW', {
  cb: 'uint32',
  lpReserved: 'str16',
  lpDesktop: 'str16',
  lpTitle: 'str16',
  dwX: 'uint32',
  dwY: 'uint32',
  dwXSize: 'uint32',
  dwYSize: 'uint32',
  dwXCountChars: 'uint32',
  dwYCountChars: 'uint32',
  dwFillAttribute: 'uint32',
  dwFlags: 'uint32',
  wShowWindow: 'uint16',
  cbReserved2: 'uint16',
  lpReserved2: koffi.pointer('uint8'),
  hStdInput: PVOID,
  hStdOutput: PVOID,
  hStdError: PVOID,
})
const STARTUPINFOEXW = koffi.struct('STARTUPINFOEXW', { StartupInfo: STARTUPINFOW, lpAttributeList: PVOID })
const PROCESS_INFORMATION = koffi.struct('PROCESS_INFORMATION', {
  hProcess: PVOID,
  hThread: PVOID,
  dwProcessId: 'uint32',
  dwThreadId: 'uint32',
})

// ---------- API 绑定（koffi 3 __stdcall 数组形式） ----------
function bind(lib, name, result, args) {
  return lib.func('__stdcall', name, result, args)
}

const OpenProcessToken = bind(advapi32, 'OpenProcessToken', 'int', [PVOID, 'uint32', PPVOID])
const GetCurrentProcess = bind(kernel32, 'GetCurrentProcess', PVOID, [])
const GetTokenInformation = bind(advapi32, 'GetTokenInformation', 'int', [PVOID, 'int', PVOID, 'uint32', koffi.pointer('uint32')])
const GetLengthSid = bind(advapi32, 'GetLengthSid', 'uint32', [PVOID])
const CopySid = bind(advapi32, 'CopySid', 'int', ['uint32', PVOID, PVOID])
const ConvertSidToStringSidW = bind(advapi32, 'ConvertSidToStringSidW', 'int', [PVOID, PPVOID])
const ConvertStringSidToSidW = bind(advapi32, 'ConvertStringSidToSidW', 'int', ['str16', PPVOID])
const CreateRestrictedToken = bind(advapi32, 'CreateRestrictedToken', 'int', [PVOID, 'uint32', 'uint32', PVOID, 'uint32', PVOID, 'uint32', PVOID, PPVOID])
const GetNamedSecurityInfoW = bind(advapi32, 'GetNamedSecurityInfoW', 'uint32', ['str16', 'int', 'uint32', PPVOID, PPVOID, PPVOID, PPVOID, PPVOID])
const SetNamedSecurityInfoW = bind(advapi32, 'SetNamedSecurityInfoW', 'uint32', ['str16', 'int', 'uint32', PVOID, PVOID, PVOID, PVOID])
const SetEntriesInAclW = bind(advapi32, 'SetEntriesInAclW', 'uint32', ['uint32', PVOID, PVOID, PPVOID])
const LocalFree = bind(kernel32, 'LocalFree', PVOID, [PVOID])
const CreateJobObjectW = bind(kernel32, 'CreateJobObjectW', PVOID, [PVOID, 'str16'])
const SetInformationJobObject = bind(kernel32, 'SetInformationJobObject', 'int', [PVOID, 'int', PVOID, 'uint32'])
const AssignProcessToJobObject = bind(kernel32, 'AssignProcessToJobObject', 'int', [PVOID, PVOID])
const ResumeThread = bind(kernel32, 'ResumeThread', 'uint32', [PVOID])
const CreateProcessAsUserW = bind(advapi32, 'CreateProcessAsUserW', 'int', [PVOID, 'str16', 'str16', PVOID, PVOID, 'int', 'uint32', PVOID, 'str16', koffi.pointer(STARTUPINFOW), koffi.pointer(PROCESS_INFORMATION)])
const InitializeProcThreadAttributeList = bind(kernel32, 'InitializeProcThreadAttributeList', 'int', [PVOID, 'uint32', 'uint32', koffi.pointer('uint64')])
const UpdateProcThreadAttribute = bind(kernel32, 'UpdateProcThreadAttribute', 'int', [PVOID, 'uint32', 'uint64', PVOID, 'uint64', PVOID, PVOID])
const DeleteProcThreadAttributeList = bind(kernel32, 'DeleteProcThreadAttributeList', 'void', [PVOID])
const CreateProcessW = bind(kernel32, 'CreateProcessW', 'int', [PVOID, 'str16', PVOID, PVOID, 'int', 'uint32', PVOID, 'str16', koffi.pointer(STARTUPINFOEXW), koffi.pointer(PROCESS_INFORMATION)])
const WaitForSingleObject = bind(kernel32, 'WaitForSingleObject', 'uint32', [PVOID, 'uint32'])
const GetExitCodeProcess = bind(kernel32, 'GetExitCodeProcess', 'int', [PVOID, koffi.pointer('uint32')])
const CloseHandle = bind(kernel32, 'CloseHandle', 'int', [PVOID])
const GetStdHandle = bind(kernel32, 'GetStdHandle', PVOID, ['int'])
const SetHandleInformation = bind(kernel32, 'SetHandleInformation', 'int', [PVOID, 'uint32', 'uint32'])
const GetLastError = bind(kernel32, 'GetLastError', 'uint32', [])

// ---------- 工具 ----------
function fail(detail) {
  process.stderr.write(`sandbox-run: ${detail}\n`)
  process.exit(127)
}

function lastError(api) {
  return `${api} failed (win32 error ${GetLastError()})`
}

function isNullPtr(ptr) {
  return ptr === null || ptr === undefined || ptr === 0n
}

// 参数解析：--mode <job|restricted> --workspace <abs> [--writable-root <abs>]... -- <argv...>
function parseArgs(argv) {
  const args = { mode: null, workspace: null, writableRoots: [], command: null }
  let i = 0
  while (i < argv.length) {
    const a = argv[i]
    if (a === '--') {
      args.command = argv.slice(i + 1)
      break
    }
    if (a === '--mode') {
      args.mode = argv[++i]
    } else if (a === '--workspace') {
      args.workspace = argv[++i]
    } else if (a === '--writable-root') {
      args.writableRoots.push(argv[++i])
    } else {
      fail(`unknown option: ${a}`)
    }
    i++
  }
  if (args.mode !== 'job' && args.mode !== 'restricted') {
    fail('usage: runner.mjs --mode <job|restricted> --workspace <abs> [--writable-root <abs>]... -- <argv...>')
  }
  if (!args.workspace || !args.command || args.command.length === 0) {
    fail('usage: runner.mjs --mode <job|restricted> --workspace <abs> [--writable-root <abs>]... -- <argv...>')
  }
  return args
}

// Windows CommandLineToArgvW 规则转义（尾随反斜杠翻倍，避免转义闭合引号）
function quoteArg(argument) {
  if (argument === '') return '""'
  if (!/[\s"]/.test(argument)) return argument
  let quoted = '"'
  for (let index = 0; index < argument.length; index++) {
    let backslashes = 0
    while (index < argument.length && argument.charAt(index) === '\\') {
      backslashes++
      index++
    }
    if (index === argument.length) {
      quoted += '\\'.repeat(backslashes * 2)
    } else if (argument.charAt(index) === '"') {
      quoted += '\\'.repeat(backslashes * 2 + 1) + '"'
    } else {
      quoted += '\\'.repeat(backslashes) + argument.charAt(index)
    }
  }
  return quoted + '"'
}

function buildCommandLine(args) {
  return args.map(quoteArg).join(' ')
}

// 确定性 SID 派生：sha256(canonicalPath) → S-1-4-21-<4 words>（workspace SID 每目录每机稳定）
function deriveSid(path) {
  const canonical = path.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '')
  const digest = createHash('sha256').update(canonical, 'utf8').digest()
  const words = []
  for (let i = 0; i < 4; i++) {
    words.push(digest.readUInt32BE(i * 4) >>> 0)
  }
  return `S-1-4-21-${words.join('-')}`
}

// ---------- token（restricted 模式） ----------
function currentTokenHandle() {
  const slot = koffi.alloc(PVOID, 1)
  // TOKEN_ADJUST_DEFAULT：SetTokenInformation(TokenDefaultDacl) 需要；TOKEN_ASSIGN_PRIMARY：CreateProcessAsUserW 需要
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_ASSIGN_PRIMARY | TOKEN_DUPLICATE | TOKEN_QUERY | TOKEN_ADJUST_DEFAULT, slot)) {
    fail(lastError('OpenProcessToken'))
  }
  return koffi.decode(slot, PVOID)
}

// 从 token 取 logon SID 并复制到独立内存（keep-alive，dsh 实测缺失导致 DLL 初始化 0xC0000142；
// 必须复制——源 buffer 释放/GC 后指针悬垂）
function logonSid(hToken) {
  const buf = Buffer.alloc(8 + 16 * TOKEN_GROUPS_MAX)
  const lenSlot = koffi.alloc('uint32', 1)
  if (!GetTokenInformation(hToken, TokenGroups, buf, buf.length, lenSlot)) {
    fail(lastError('GetTokenInformation(TokenGroups)'))
  }
  const count = buf.readUInt32LE(0)
  for (let i = 0; i < count; i++) {
    const off = 8 + i * 16
    const attrs = buf.readUInt32LE(off + 8)
    // JS 位运算返回 int32 有符号，需 >>> 0 无符号化后再比较（0xc0000000 高位为 1）
    if (((attrs & SE_GROUP_LOGON_ID) >>> 0) === SE_GROUP_LOGON_ID) {
      const sidPtr = koffi.decode(buf, off, PVOID)
      const len = GetLengthSid(sidPtr)
      const copy = koffi.alloc('uint8', len)
      if (!CopySid(len, copy, sidPtr)) fail(lastError('CopySid'))
      return copy
    }
  }
  fail('logon SID not found in token groups')
}

function sidToString(sidPtr) {
  const outSlot = koffi.alloc(PVOID, 1)
  if (!ConvertSidToStringSidW(sidPtr, outSlot)) fail(lastError('ConvertSidToStringSidW'))
  const strPtr = koffi.decode(outSlot, PVOID)
  // 注意：koffi.decode(strPtr, 'string16') 会 native crash（koffi 3.1.6 bug），必须用 decode.string16
  const s = koffi.decode.string16(strPtr)
  LocalFree(strPtr)
  return s
}

function stringToSid(sidStr) {
  const outSlot = koffi.alloc(PVOID, 1)
  if (!ConvertStringSidToSidW(sidStr, outSlot)) fail(lastError('ConvertStringSidToSidW'))
  return koffi.decode(outSlot, PVOID)
}

function createRestrictedToken(hToken, restrictSids) {
  const count = restrictSids.length
  const entries = koffi.alloc(SID_AND_ATTRIBUTES, count)
  const stride = BigInt(koffi.sizeof(SID_AND_ATTRIBUTES))
  for (let i = 0; i < count; i++) {
    koffi.encode(entries + stride * BigInt(i), SID_AND_ATTRIBUTES, { Sid: restrictSids[i], Attributes: 0 })
  }
  const newTokenSlot = koffi.alloc(PVOID, 1)
  // DISABLE_MAX_PRIVILEGE | LUA_TOKEN | WRITE_RESTRICTED（dsh 同款 flags）
  if (!CreateRestrictedToken(hToken, DISABLE_MAX_PRIVILEGE | LUA_TOKEN | WRITE_RESTRICTED, 0, null, 0, null, count, entries, newTokenSlot)) {
    fail(lastError('CreateRestrictedToken'))
  }
  return koffi.decode(newTokenSlot, PVOID)
}

// ---------- ACL（restricted 模式） ----------
// 检查 DACL 是否已有该 SID 的 allow ACE（幂等 skip，避免全树重复传播；大 workspace 首测仅慢一次）
function aclHasAllowAce(pDacl, sidStr, mask) {
  if (isNullPtr(pDacl)) return false
  // ACL 布局：revision(1) sbz1(1) AclSize(2)@2 AceCount(2)@4 sbz2(2)@6 ACEs@8
  // ACCESS_ALLOWED_ACE：Header(4) + Mask(4) + SID 内嵌（SID 起始 = ACE 基址 + 8，非指针）
  const aceCount = koffi.decode(pDacl, 4, 'uint16')
  let off = 8
  for (let i = 0; i < aceCount; i++) {
    const aceType = koffi.decode(pDacl, off, 'uint8')
    const aceSize = koffi.decode(pDacl, off + 2, 'uint16')
    if (aceType === ACCESS_ALLOWED_ACE_TYPE && aceSize >= 16) {
      const aceMask = koffi.decode(pDacl, off + 4, 'uint32')
      if ((aceMask & mask) === mask && sidToString(pDacl + BigInt(off + 8)) === sidStr) return true
    }
    off += aceSize
  }
  return false
}

// 种写 ACE（SetEntriesInAclW 对同 trustee 合并 = 幂等）；已存在同 SID 同权限则跳过传播
function grantWrite(path, sidPtr, sidStr) {
  const ownerSlot = koffi.alloc(PVOID, 1)
  const groupSlot = koffi.alloc(PVOID, 1)
  const daclSlot = koffi.alloc(PVOID, 1)
  const saclSlot = koffi.alloc(PVOID, 1)
  const descSlot = koffi.alloc(PVOID, 1)
  const r = GetNamedSecurityInfoW(path, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, ownerSlot, groupSlot, daclSlot, saclSlot, descSlot)
  if (r !== 0) fail(`GetNamedSecurityInfoW(${path}) failed (error ${r})`)
  const pDacl = koffi.decode(daclSlot, PVOID)
  const pDesc = koffi.decode(descSlot, PVOID)
  if (aclHasAllowAce(pDacl, sidStr, FILE_GENERIC_WRITE)) {
    if (!isNullPtr(pDesc)) LocalFree(pDesc)
    return
  }

  const entries = koffi.alloc(EXPLICIT_ACCESS_W, 1)
  koffi.encode(entries, EXPLICIT_ACCESS_W, {
    grfAccessPermissions: FILE_GENERIC_WRITE,
    grfAccessMode: GRANT_ACCESS,
    grfInheritance: CONTAINER_INHERIT_ACE | OBJECT_INHERIT_ACE,
    Trustee: { pMultipleTrustee: null, MultipleTrusteeOperation: 0, TrusteeForm: TRUSTEE_IS_SID, TrusteeType: TRUSTEE_IS_UNKNOWN, ptstrName: sidPtr },
  })
  const newDaclSlot = koffi.alloc(PVOID, 1)
  const r2 = SetEntriesInAclW(1, entries, pDacl, newDaclSlot)
  if (r2 !== 0) fail(`SetEntriesInAclW(${path}) failed (error ${r2})`)
  const newDacl = koffi.decode(newDaclSlot, PVOID)
  const r3 = SetNamedSecurityInfoW(path, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, null, null, newDacl, null)
  LocalFree(newDacl)
  if (!isNullPtr(pDesc)) LocalFree(pDesc)
  if (r3 !== 0) fail(`SetNamedSecurityInfoW(${path}) failed (error ${r3})`)
}

// ---------- job ----------
function createKillOnCloseJob() {
  const hJob = CreateJobObjectW(null, null)
  if (isNullPtr(hJob)) fail(lastError('CreateJobObjectW'))
  // JOBOBJECT_EXTENDED_LIMIT_INFORMATION：LimitFlags @ offset 16（x64 布局，dsh 验证）
  const information = Buffer.alloc(144)
  information.writeUInt32LE(KILL_ON_JOB_CLOSE, 16)
  // TEMP-DEBUG: 与 C# 对照版一致，仅 KILL_ON_JOB_CLOSE
  // information.writeUInt32LE(ACTIVE_PROCESS_LIMIT, 40)
  if (!SetInformationJobObject(hJob, JobObjectExtendedLimitInformation, information, information.length)) {
    fail(lastError('SetInformationJobObject'))
  }
  return hJob
}

// ---------- stdio ----------
function stdioHandles() {
  const stdio = [STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE].map((h) => GetStdHandle(h))
  for (const h of stdio) {
    if (!isNullPtr(h) && !SetHandleInformation(h, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT)) {
      fail(lastError('SetHandleInformation'))
    }
  }
  return stdio
}

function restoreStdio(stdio) {
  for (const h of stdio) {
    if (!isNullPtr(h)) SetHandleInformation(h, HANDLE_FLAG_INHERIT, 0) // 最佳努力恢复，不掩蔽子进程结果
  }
}

function buildStartupInfo(stdio, size) {
  const si = koffi.alloc(STARTUPINFOW, 1)
  koffi.encode(si, STARTUPINFOW, {
    cb: koffi.sizeof(STARTUPINFOW),
    lpReserved: null,
    // TEMP-DEBUG: 与 C# 对照版一致，不设 lpDesktop
    lpDesktop: null,
    lpTitle: null,
    dwX: 0,
    dwY: 0,
    dwXSize: 0,
    dwYSize: 0,
    dwXCountChars: 0,
    dwYCountChars: 0,
    dwFillAttribute: 0,
    dwFlags: STARTF_USESTDHANDLES,
    wShowWindow: 0,
    cbReserved2: 0,
    lpReserved2: null,
    hStdInput: stdio[0],
    hStdOutput: stdio[1],
    hStdError: stdio[2],
  })
  return si
}

function waitAndGetExitCode(hProcess) {
  WaitForSingleObject(hProcess, 0xffffffff)
  const exitSlot = koffi.alloc('uint32', 1)
  if (!GetExitCodeProcess(hProcess, exitSlot)) fail(lastError('GetExitCodeProcess'))
  return koffi.decode(exitSlot, 'uint32')
}

// ---------- job 模式：CreateProcessW + JOB_LIST 属性（无需特权） ----------
function spawnJob(args, hJob, commandLine) {
  // 属性列表：job 挂入（JOB_LIST 是文档支持的属性，需 EXTENDED_STARTUPINFO_PRESENT）
  const sizeSlot = koffi.alloc('uint64', 1)
  InitializeProcThreadAttributeList(null, 1, 0, sizeSlot) // 预期 FALSE(122)，仅取大小
  const attrList = koffi.alloc('uint8', Number(koffi.decode(sizeSlot, 'uint64')))
  if (!InitializeProcThreadAttributeList(attrList, 1, 0, sizeSlot)) fail(lastError('InitializeProcThreadAttributeList'))
  const jobBuf = koffi.alloc(PVOID, 1)
  koffi.encode(jobBuf, PVOID, hJob)
  if (!UpdateProcThreadAttribute(attrList, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST, jobBuf, BigInt(koffi.sizeof(PVOID)), null, null)) {
    fail(lastError('UpdateProcThreadAttribute(JOB_LIST)'))
  }

  const si = koffi.alloc(STARTUPINFOEXW, 1)
  koffi.encode(si, STARTUPINFOEXW, {
    StartupInfo: {
      cb: koffi.sizeof(STARTUPINFOEXW),
      lpReserved: null,
      lpDesktop: null,
      lpTitle: null,
      dwX: 0,
      dwY: 0,
      dwXSize: 0,
      dwYSize: 0,
      dwXCountChars: 0,
      dwYCountChars: 0,
      dwFillAttribute: 0,
      dwFlags: STARTF_USESTDHANDLES,
      wShowWindow: 0,
      cbReserved2: 0,
      lpReserved2: null,
      hStdInput: args.stdio[0],
      hStdOutput: args.stdio[1],
      hStdError: args.stdio[2],
    },
    lpAttributeList: attrList,
  })
  const processInfo = koffi.alloc(PROCESS_INFORMATION, 1)
  const created = CreateProcessW(null, commandLine, null, null, 1, EXTENDED_STARTUPINFO_PRESENT, null, args.workspace, si, processInfo)
  DeleteProcThreadAttributeList(attrList)
  if (!created) fail(lastError('CreateProcessW'))
  return processInfo
}

// ---------- restricted 模式：CreateProcessAsUserW 受限 token + job（需特权） ----------
function spawnRestricted(args, hRestricted, hJob, commandLine) {
  const si = buildStartupInfo(args.stdio)
  const processInfo = koffi.alloc(PROCESS_INFORMATION, 1)
  const created = CreateProcessAsUserW(hRestricted, null, commandLine, null, null, 1, CREATE_SUSPENDED, null, args.workspace, si, processInfo)
  if (!created) fail(lastError('CreateProcessAsUserW'))

  const info = koffi.decode(processInfo, PROCESS_INFORMATION)
  if (isNullPtr(info.hProcess) || isNullPtr(info.hThread)) fail('CreateProcessAsUserW returned null handles')

  if (!AssignProcessToJobObject(hJob, info.hProcess)) {
    fail(lastError('AssignProcessToJobObject'))
  }
  if (ResumeThread(info.hThread) === 0xffffffff) {
    fail(lastError('ResumeThread'))
  }
  CloseHandle(info.hThread)
  return processInfo
}

// ---------- 主流程 ----------
function main() {
  const args = parseArgs(process.argv.slice(2))
  args.stdio = stdioHandles()
  const commandLine = buildCommandLine(args.command)
  const hJob = createKillOnCloseJob()

  let tempDir = null
  let hRestricted = null

  if (args.mode === 'restricted') {
    // 私有 temp 目录（随机名 + 独立 SID），TMP/TEMP 重写后交子进程
    tempDir = mkdtempSync(join(tmpdir(), 'heluo-sandbox-'))
    process.env.TMP = tempDir
    process.env.TEMP = tempDir

    const workspaceSidStr = deriveSid(args.workspace)
    const tempSidStr = deriveSid(tempDir)
    const workspaceSid = stringToSid(workspaceSidStr)
    const tempSid = stringToSid(tempSidStr)
    const everyoneSid = stringToSid('S-1-1-0')

    const hToken = currentTokenHandle()
    const logonSidPtr = logonSid(hToken)
    const restrictSids = [logonSidPtr, everyoneSid, workspaceSid, tempSid]
    hRestricted = createRestrictedToken(hToken, restrictSids)
    CloseHandle(hToken)

    // 种 ACE：workspace + temp + writableRoots（runner 为正常 token，目录 owner 的 WRITE_DAC 可用）
    grantWrite(args.workspace, workspaceSid, workspaceSidStr)
    grantWrite(tempDir, tempSid, tempSidStr)
    for (const root of args.writableRoots) {
      const sidStr = deriveSid(root)
      grantWrite(root, stringToSid(sidStr), sidStr)
    }
  }

  const processInfo = args.mode === 'job'
    ? spawnJob(args, hJob, commandLine)
    : spawnRestricted(args, hRestricted, hJob, commandLine)

  restoreStdio(args.stdio)
  const info = koffi.decode(processInfo, PROCESS_INFORMATION)
  if (hRestricted) CloseHandle(hRestricted)

  // 等待退出 → 退出码透传。KILL_ON_JOB_CLOSE：hJob 必须保持打开直到子进程退出，
  // 关闭最后一个 job 句柄会立即终止 job 内全部进程。
  const code = waitAndGetExitCode(info.hProcess)
  CloseHandle(info.hProcess)
  CloseHandle(hJob)

  // 清理私有 temp（ACE 随目录消失）；workspace ACE standing 保留（幂等 skip 复用）
  if (tempDir) {
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      /* 残留为 inert 垃圾，可接受 */
    }
  }
  process.exitCode = code
}

main()