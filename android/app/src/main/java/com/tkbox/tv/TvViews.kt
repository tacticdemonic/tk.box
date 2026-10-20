package com.tkbox.tv

import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.StateListDrawable
import android.text.InputType
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView

internal fun Context.dp(value: Int) =
    TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value.toFloat(), resources.displayMetrics).toInt()

/** Adds one full-width control below the previous one with consistent spacing. */
fun LinearLayout.addTv(view: View, spacingDp: Int = 16) {
    addView(view, LinearLayout.LayoutParams(
        LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT
    ).apply { topMargin = context.dp(spacingDp) })
}

/** TV-sized controls with a focus ring the D-pad can follow. */
object TvViews {
    private fun background(context: Context, focused: Boolean) = GradientDrawable().apply {
        cornerRadius = context.dp(6).toFloat()
        setColor(Color.parseColor(if (focused) "#292933" else "#1d1d25"))
        setStroke(context.dp(if (focused) 3 else 1), Color.parseColor(if (focused) "#f5b82e" else "#3a3a44"))
    }

    private fun focusable(context: Context) = StateListDrawable().apply {
        addState(intArrayOf(android.R.attr.state_focused), background(context, true))
        addState(intArrayOf(), background(context, false))
    }

    fun text(context: Context, value: String, size: Float, bold: Boolean = false) = TextView(context).apply {
        text = value
        setTextColor(Color.parseColor("#f4f4f6"))
        setTextSize(TypedValue.COMPLEX_UNIT_SP, size)
        if (bold) setTypeface(Typeface.DEFAULT_BOLD)
        gravity = Gravity.CENTER_HORIZONTAL
    }

    fun field(context: Context, hint: String) = EditText(context).apply {
        this.hint = hint
        inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
        setTextColor(Color.parseColor("#f4f4f6"))
        setHintTextColor(Color.parseColor("#6c6c78"))
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 20f)
        setSingleLine()
        setPadding(context.dp(16), context.dp(12), context.dp(16), context.dp(12))
        background = focusable(context)
        isFocusable = true
        isFocusableInTouchMode = false
    }

    fun button(context: Context, label: String, onClick: () -> Unit) = Button(context).apply {
        text = label
        setTextColor(Color.parseColor("#f4f4f6"))
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 18f)
        isAllCaps = false
        isFocusable = true
        isFocusableInTouchMode = false
        background = focusable(context)
        setOnClickListener { onClick() }
    }

    /** A centered column that also works as a full-screen overlay. */
    fun column(context: Context) = LinearLayout(context).apply {
        orientation = LinearLayout.VERTICAL
        gravity = Gravity.CENTER
        setPadding(context.dp(48), context.dp(48), context.dp(48), context.dp(48))
        layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
    }
}
