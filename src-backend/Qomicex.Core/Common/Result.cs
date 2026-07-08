using System;

namespace Qomicex.Core.Common;

/// <summary>
/// 结果类型 - 用于 Railway-Oriented Programming
/// 替代异常处理预期错误场景
/// </summary>
/// <typeparam name="TValue">成功时的值类型</typeparam>
/// <typeparam name="TError">失败时的错误类型</typeparam>
public readonly record struct Result<TValue, TError>
{
    private readonly TValue? _value;
    private readonly TError? _error;
    private readonly bool _isSuccess;

    private Result(TValue value)
    {
        _value = value;
        _error = default;
        _isSuccess = true;
    }

    private Result(TError error)
    {
        _value = default;
        _error = error;
        _isSuccess = false;
    }

    public bool IsSuccess => _isSuccess;
    public bool IsFailure => !_isSuccess;

    public TValue Value => _isSuccess
        ? _value!
        : throw new InvalidOperationException("Cannot access Value of a failed result");

    public TError Error => !_isSuccess
        ? _error!
        : throw new InvalidOperationException("Cannot access Error of a successful result");

    public static Result<TValue, TError> Success(TValue value) => new(value);
    public static Result<TValue, TError> Failure(TError error) => new(error);

    /// <summary>
    /// 映射成功值到另一种类型
    /// </summary>
    public Result<TOut, TError> Map<TOut>(Func<TValue, TOut> mapper)
        => _isSuccess
            ? Result<TOut, TError>.Success(mapper(_value!))
            : Result<TOut, TError>.Failure(_error!);

    /// <summary>
    /// 绑定操作 - 链式处理结果
    /// </summary>
    public Result<TOut, TError> Bind<TOut>(Func<TValue, Result<TOut, TError>> binder)
        => _isSuccess ? binder(_value!) : Result<TOut, TError>.Failure(_error!);

    /// <summary>
    /// 获取值或默认值
    /// </summary>
    public TValue GetValueOr(TValue defaultValue)
        => _isSuccess ? _value! : defaultValue;

    /// <summary>
    /// 模式匹配解构
    /// </summary>
    public TResult Match<TResult>(
        Func<TValue, TResult> onSuccess,
        Func<TError, TResult> onFailure)
        => _isSuccess ? onSuccess(_value!) : onFailure(_error!);

    /// <summary>
    /// 执行副作用操作
    /// </summary>
    public Result<TValue, TError> Tap(Action<TValue> onSuccess)
    {
        if (_isSuccess) onSuccess(_value!);
        return this;
    }

    /// <summary>
    /// 失败时执行副作用操作
    /// </summary>
    public Result<TValue, TError> TapError(Action<TError> onFailure)
    {
        if (!_isSuccess) onFailure(_error!);
        return this;
    }
}

/// <summary>
/// 简单的结果类型，使用字符串作为错误
/// </summary>
public readonly record struct Result<TValue>
{
    private readonly TValue? _value;
    private readonly string? _error;
    private readonly bool _isSuccess;

    private Result(TValue value)
    {
        _value = value;
        _error = null;
        _isSuccess = true;
    }

    private Result(string error)
    {
        _value = default;
        _error = error;
        _isSuccess = false;
    }

    public bool IsSuccess => _isSuccess;
    public bool IsFailure => !_isSuccess;

    public TValue Value => _isSuccess
        ? _value!
        : throw new InvalidOperationException("Cannot access Value of a failed result");

    public string Error => !_isSuccess
        ? _error!
        : throw new InvalidOperationException("Cannot access Error of a successful result");

    public static Result<TValue> Success(TValue value) => new(value);
    public static Result<TValue> Failure(string error) => new(error);

    public Result<TOut> Map<TOut>(Func<TValue, TOut> mapper)
        => _isSuccess
            ? Result<TOut>.Success(mapper(_value!))
            : Result<TOut>.Failure(_error!);

    public Result<TOut> Bind<TOut>(Func<TValue, Result<TOut>> binder)
        => _isSuccess ? binder(_value!) : Result<TOut>.Failure(_error!);

    public TValue GetValueOr(TValue defaultValue)
        => _isSuccess ? _value! : defaultValue;

    public TResult Match<TResult>(
        Func<TValue, TResult> onSuccess,
        Func<string, TResult> onFailure)
        => _isSuccess ? onSuccess(_value!) : onFailure(_error!);
}

/// <summary>
/// 日志分析错误类型
/// </summary>
public readonly record struct LogAnalysisError
{
    public required string Code { get; init; }
    public required string Message { get; init; }
    public string? Details { get; init; }

    public override string ToString() => $"[{Code}] {Message}";
}
